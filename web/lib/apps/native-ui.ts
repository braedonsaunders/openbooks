import { z } from "zod";
import type { PageSpec } from "@braedonsaunders/appkit-viewspec";
import { formSectionSchema } from "@openbooks/forms-core";
import { lintRecordFields } from "../record-schema";
import type { AppManifest } from "./manifest";
import { validateAgainstRegistries } from "../page-spec-validate";
import { WIDGET_CONTRACTS } from "../../components/viewspec/widget-contracts";
import { APP_SCREEN_WIDGETS, presentationPropErrors } from "../presentation-widgets";

const APP_SCREEN_CONTRACTS = Object.fromEntries(
  [...APP_SCREEN_WIDGETS].map((name) => [name, WIDGET_CONTRACTS[name] ?? { props: [] }]),
);

/** Native extension screens compose host layouts and governed custom-record workspaces.
 * No uploaded JS executes in the host origin, and no tenant-supplied widget can
 * obtain ambient server capabilities. Custom JavaScript frontends use the isolated sandbox renderer.
 */
const screenKey = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/)
  .max(64);
export const nativeExtensionSchema = z
  .object({
    screens: z
      .array(
        z.discriminatedUnion("kind", [
          z
            .object({
              key: screenKey,
              title: z.string().min(1).max(120),
              kind: z.literal("page"),
              description: z.string().max(2000).optional(),
              /** A declared GET endpoint whose returned body the spec binds as `data.*`, run read-only as the viewer. */
              data: z.object({ endpoint: screenKey }).strict().optional(),
              // Checked by the shared spec validator below, which names the exact
              // property inside a block rather than dumping the whole union failure.
              spec: z.custom<PageSpec>(
                (value) => value !== null && typeof value === "object" && !Array.isArray(value),
                "spec must be a PageSpec object",
              ),
            })
            .strict(),
          z
            .object({
              key: screenKey,
              title: z.string().min(1).max(120),
              kind: z.literal("records"),
              typeKey: screenKey,
            })
            .strict(),
          z
            .object({
              key: screenKey,
              title: z.string().min(1).max(120),
              kind: z.literal("action"),
              endpoint: screenKey,
              fields: z.array(formSectionSchema).max(50),
              submitLabel: z.string().min(1).max(120),
              description: z.string().max(2000).optional(),
              confirmation: z.string().min(1).max(1000).optional(),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(20),
  })
  .strict()
  .superRefine((value, ctx) => {
    const keys = new Set<string>();
    for (const [index, screen] of value.screens.entries()) {
      if (keys.has(screen.key))
        ctx.addIssue({
          code: "custom",
          path: ["screens", index, "key"],
          message: "duplicate screen key",
        });
      keys.add(screen.key);
      if (screen.kind === "action") {
        const checked = lintRecordFields(screen.fields, screen.title);
        for (const issue of checked.issues)
          ctx.addIssue({
            code: "custom",
            path: ["screens", index, "fields", ...issue.path],
            message: issue.message,
          });
      }
      if (screen.kind === "page") {
        const checked = validateAgainstRegistries(screen.spec, {
          widgets: APP_SCREEN_WIDGETS,
          frames: new Set(),
          contracts: APP_SCREEN_CONTRACTS,
        });
        if (!checked.ok)
          for (const message of checked.errors)
            ctx.addIssue({ code: "custom", path: ["screens", index, "spec"], message });
        else
          for (const message of presentationPropErrors(screen.spec))
            ctx.addIssue({ code: "custom", path: ["screens", index, "spec"], message });
      }
    }
  });
export type NativeExtension = z.infer<typeof nativeExtensionSchema>;

export function parseNativeExtension(content: string, manifest?: AppManifest): NativeExtension {
  const ui = nativeExtensionSchema.parse(JSON.parse(content));
  if (manifest)
    for (const screen of ui.screens) {
      if (
        screen.kind === "action" &&
        !manifest.endpoints.some(
          (endpoint) => endpoint.name === screen.endpoint && endpoint.method !== "GET",
        )
      ) {
        throw new Error(`Action "${screen.key}" requires a declared POST or ANY backend endpoint`);
      }
      if (
        screen.kind === "page" &&
        screen.data &&
        !manifest.endpoints.some(
          (endpoint) => endpoint.name === screen.data!.endpoint && endpoint.method !== "POST",
        )
      ) {
        throw new Error(
          `Page "${screen.key}" data requires a declared GET or ANY backend endpoint named "${screen.data.endpoint}"`,
        );
      }
    }
  return ui;
}
