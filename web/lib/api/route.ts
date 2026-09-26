import * as authzModule from "@/lib/authz";
import type { Authz } from "@/lib/authz";
import { NextResponse } from "next/server";
import type { z } from "zod";
import { apiErrorResponse } from "./error-response";
import { parseJsonBody } from "./json";
import { notFound } from "./responses";

/**
 * The one factory for API routes (`docs/design/api-routes.md`).
 *
 * Every non-public route declares its permission AND its feature: a feature
 * key, or `{ none: "<reason>" }` for the few always-on surfaces. The type
 * refuses omission, and `scripts/check-route-permission-coverage.mjs`
 * refuses an empty reason and prints every `{ none }` route for review.
 *
 * Gate order is fixed: permission (or public) → feature (leaf key only;
 * the registry resolves parents) → scope → params → body → handler.
 * A disabled feature answers 404 with no existence leak, exactly like
 * `guardFeaturePermission`. Typed business refusals (named errors with a
 * 4xx status) become 4xx responses carrying their `code`/`field`/`remedy`;
 * anything else rethrows so the edge request id lands in the server log,
 * never the body.
 *
 * `export const runtime = "nodejs"` lives here so factory routes do not
 * repeat it per file.
 */
export const runtime = "nodejs";

export type RouteScope = "unrestricted" | "root";
export type FeatureGate = string | { none: string };

interface CommonOptions<
  A,
  P extends z.ZodType | undefined,
  B extends z.ZodType | undefined,
> {
  params?: P;
  body?: B;
  handler: (ctx: {
    request: Request;
    authz: A;
    params: P extends z.ZodType ? z.output<P> : unknown;
    body: B extends z.ZodType ? z.output<B> : undefined;
  }) => Promise<Response> | Response;
}

export interface TokenRouteOptions<
  P extends z.ZodType | undefined = undefined,
  B extends z.ZodType | undefined = undefined,
> extends CommonOptions<null, P, B> {
  /**
   * Sessionless by design: the route authenticates every request itself
   * (API key, provider HMAC, secret link token) and the factory performs
   * no session check. The path must already be public under
   * `web/lib/proxy-policy.ts` — public routes are declared there, nowhere
   * else.
   */
  public: "token";
}

export interface SessionRouteOptions<
  P extends z.ZodType | undefined = undefined,
  B extends z.ZodType | undefined = undefined,
> extends CommonOptions<Authz, P, B> {
  /** Authenticated session, no permission: self-service surfaces. */
  public: "session";
  scope?: RouteScope;
}

export interface PermissionRouteOptions<
  P extends z.ZodType | undefined = undefined,
  B extends z.ZodType | undefined = undefined,
> extends CommonOptions<Authz, P, B> {
  permission: string;
  feature: FeatureGate;
  scope?: RouteScope;
}

// Implementation-only handler shape: `never` fields keep this signature
// compatible with every overload's handler (never assigns both ways for
// the call-site check below). Public overloads stay precise.
type LooseHandler = (ctx: {
  request: Request;
  authz: never;
  params: never;
  body: never;
}) => Promise<Response> | Response;

interface LooseOptions {
  public?: "token" | "session";
  permission?: string;
  feature?: FeatureGate;
  scope?: RouteScope;
  params?: z.ZodType;
  body?: z.ZodType;
  handler: LooseHandler;
}

export function defineRoute<
  P extends z.ZodType | undefined = undefined,
  B extends z.ZodType | undefined = undefined,
>(
  options: TokenRouteOptions<P, B>,
): (request: Request, context?: { params?: Promise<unknown> }) => Promise<Response>;
export function defineRoute<
  P extends z.ZodType | undefined = undefined,
  B extends z.ZodType | undefined = undefined,
>(
  options: SessionRouteOptions<P, B> | PermissionRouteOptions<P, B>,
): (request: Request, context?: { params?: Promise<unknown> }) => Promise<Response>;
export function defineRoute(options: LooseOptions) {
  return async (
    request: Request,
    context?: { params?: Promise<unknown> },
  ): Promise<Response> => {
    try {
      let authz: Authz | null;
      if (options.permission !== undefined) {
        const permission = options.permission;
        const feature = options.feature;
        if (typeof feature === "string") {
          // Lazy so routes that never gate on a feature never load the
          // gate module; the specifier matches the production alias, which
          // is also what route-level test doubles intercept.
          const { guardFeaturePermission } = await import("@/lib/feature-gates");
          const gate = await guardFeaturePermission(permission, feature);
          if (gate instanceof NextResponse) {
            // A disabled feature hides behind the unified 404: the legacy
            // gate spells it "not found" and factory routes spell it
            // "not_found". Permission refusals pass through untouched.
            if (gate.status === 404) return notFound("route");
            return gate;
          }
          authz = gate;
        } else if (feature !== undefined) {
          // An always-on surface: the `{ none: "<reason>" }` reason is
          // enforced by the coverage check, not at request time.
          const gate = await authzModule.guardPermission(permission);
          if (gate instanceof NextResponse) return gate;
          authz = gate;
        } else {
          // The type refuses an omitted feature; a plain-JS caller that
          // omits it anyway fails closed instead of running permission-only.
          throw new Error("defineRoute: feature is required for non-public routes");
        }
      } else if (options.public === "token") {
        authz = null;
      } else {
        const session = await authzModule.getAuthz();
        if (!session) {
          return NextResponse.json({ error: "unauthorized" }, { status: 401 });
        }
        authz = session;
      }

      const scope = options.scope;
      if (authz && scope === "unrestricted") {
        const denied = authzModule.guardUnrestrictedScope(authz);
        if (denied) return denied;
      } else if (authz && scope === "root") {
        const denied = await authzModule.guardRootSubsidiaryScope(authz);
        if (denied) return denied;
      } else if (scope !== undefined) {
        // The type admits only "unrestricted" and "root". Record-level
        // subsidiary enforcement lives in the handler, which alone knows
        // which field carries the subsidiary — so a plain-JS caller passing
        // anything else fails closed instead of running unscoped.
        throw new Error(`defineRoute: unknown scope "${String(scope)}"`);
      }

      let params: unknown;
      if (context?.params !== undefined) {
        const resolved = await context.params;
        if (options.params) {
          const parsed = (options.params as z.ZodType).safeParse(resolved);
          if (!parsed.success) {
            const first = parsed.error.issues[0];
            return NextResponse.json(
              { error: first?.message ?? "invalid request parameters" },
              { status: 400 },
            );
          }
          params = parsed.data;
        } else {
          params = resolved;
        }
      }

      let body: unknown;
      if (options.body) {
        const parsedBody = await parseJsonBody(request, options.body as z.ZodType);
        if (!parsedBody.ok) return parsedBody.response;
        body = parsedBody.data;
      }

      return await options.handler({
        request,
        authz: authz as never,
        params: params as never,
        body: body as never,
      });
    } catch (error) {
      if (!isTypedRefusal(error)) throw error;
      return apiErrorResponse(error, { request, details: refusalDetails(error) });
    }
  };
}

/**
 * Mirrors the typed-refusal predicate in `./error-response.ts`: only a
 * named error class carrying a 4xx status is safe to show. Anything else —
 * a plain Error, a 5xx, a non-error throw — rethrows.
 */
function isTypedRefusal(error: unknown): error is Error & { status: number } {
  if (!(error instanceof Error) || error.constructor === Error) return false;
  const status = (error as { status?: unknown }).status;
  return (
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 400 &&
    status < 500
  );
}

/** Carry the named refusal's machine-readable detail into the 4xx body. */
function refusalDetails(error: Error): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  const source = error as unknown as Record<string, unknown>;
  if (typeof source["code"] === "string") details["code"] = source["code"];
  if (typeof source["field"] === "string") details["field"] = source["field"];
  if (
    typeof source["fieldErrors"] === "object" &&
    source["fieldErrors"] !== null &&
    !Array.isArray(source["fieldErrors"])
  ) {
    details["fieldErrors"] = source["fieldErrors"];
  }
  if (typeof source["remedy"] === "string") details["remedy"] = source["remedy"];
  return details;
}
