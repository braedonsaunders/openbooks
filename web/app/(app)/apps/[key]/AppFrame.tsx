"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { readApiErrorMessage, refusalMessageFromBody } from "@/lib/api-error";
import {
  makeBridgeResult,
  parseBridgeRequest,
  isBridgeHandshake,
  isBridgeMethod,
  type BridgeContext,
} from "@/lib/apps/bridge";

/** Reloads after an unexpected navigation before the App is left unloaded. */
const MAX_BRIDGE_REHYDRATIONS = 3;

/**
 * AppFrame — the host side of an installed App's separately served document.
 * assembles a single self-contained HTML document (assets inlined as data:
 * URLs, CSP + bridge SDK injected), and renders it in an OPAQUE-ORIGIN
 * sandboxed iframe (sandbox="allow-scripts", deliberately no allow-same-origin).
 * The App therefore runs with no cookies, no parent-DOM access, and no network
 * of its own — its only capability is bridge calls, which this component relays
 * to the permission-checked /api/apps/<key>/bridge route on the user's behalf.
 *
 * Each document load carries a fresh single-use handshake proof. The first
 * handshake presenting it binds a private MessageChannel to that document, and
 * calls are accepted only on that channel. Any later load means the frame
 * navigated away from the App, so the channel is revoked and the App document
 * is loaded again under a new proof.
 */

export function AppFrame({
  appKey,
  context,
  previewDraftId,
}: {
  appKey: string;
  context: BridgeContext;
  previewDraftId?: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const t = useTranslations("apps");
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    let proof: string | null = null;
    let port: MessagePort | null = null;
    let expectingLoad = false;
    let rehydrations = 0;
    let disposed = false;

    const revoke = () => {
      proof = null;
      port?.close();
      port = null;
    };

    // Relay one call from the bound channel to the server and answer on the
    // same channel, unless it was revoked while the call was in flight.
    async function relay(channel: MessagePort, data: unknown) {
      const req = parseBridgeRequest(data);
      if (!req) return;
      const post = (ok: boolean, payload: unknown) => {
        if (port === channel) channel.postMessage(makeBridgeResult(req.id, ok, payload));
      };

      if (previewDraftId) {
        post(false, t("bridge.previewDraftRefusal"));
        return;
      }
      if (!isBridgeMethod(req.method)) {
        post(false, t("bridge.unknownMethod", { method: req.method }));
        return;
      }
      try {
        const res = await fetch(`/api/apps/${encodeURIComponent(appKey)}/bridge`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            method: req.method,
            payload: req.payload,
            versionId: context.app.versionId,
            invocationKey: req.invocationKey,
          }),
        });
        // The status is checked before the body is parsed: a non-JSON error
        // body must surface the failure, never a SyntaxError from res.json()
        // and never an empty object that hides the server's refusal.
        if (!res.ok) {
          post(false, await readApiErrorMessage(res, t("bridge.callFailed")));
          return;
        }
        // The success body is parsed defensively too: a 200 with a non-JSON
        // or shapeless body refuses by name instead of posting success with
        // an empty result (or a SyntaxError string).
        const json = (await res.json().catch(() => null)) as {
          ok?: unknown;
          error?: unknown;
          result?: unknown;
        } | null;
        // The refusal reads through the shared helper so message, remedy and
        // code render instead of the bare `error` field.
        if (json?.ok === false) {
          post(
            false,
            refusalMessageFromBody(json, {
              fallback: t("bridge.callFailedWithStatus", { status: res.status }),
            }) ?? t("bridge.callFailedWithStatus", { status: res.status }),
          );
        } else if (!json || typeof json !== "object" || !("result" in json)) {
          post(false, t("bridge.callFailedWithStatus", { status: res.status }));
        } else post(true, json.result);
      } catch {
        // A fetch rejection has no server refusal to surface; the named,
        // translated failure beats the browser's technical TypeError string.
        post(false, t("bridge.callFailed"));
      }
    }

    function onMessage(e: MessageEvent) {
      if (e.source !== iframe!.contentWindow) return; // only our sandbox
      if (!isBridgeHandshake(e.data, proof) || !e.ports[0]) return;
      proof = null; // single use: no later document can present it
      port?.close();
      const channel = e.ports[0];
      port = channel;
      channel.onmessage = (message) => {
        void relay(channel, message.data);
      };
    }

    // Start (or restart) the App document under a fresh handshake proof.
    const load = () => {
      revoke();
      proof = crypto.randomUUID();
      expectingLoad = true;
      const query = new URLSearchParams({ bridge: proof });
      if (previewDraftId) query.set("draft", previewDraftId);
      else if (context.app.versionId) query.set("versionId", context.app.versionId);
      iframe!.src = `/api/apps/${encodeURIComponent(appKey)}/sandbox?${query}`;
    };

    function onLoad() {
      if (disposed) return;
      if (expectingLoad) {
        expectingLoad = false;
        return;
      }
      // A load nobody requested is the frame leaving the App document.
      revoke();
      if (rehydrations < MAX_BRIDGE_REHYDRATIONS) {
        rehydrations += 1;
        load();
      }
    }

    window.addEventListener("message", onMessage);
    iframe.addEventListener("load", onLoad);
    // Start the document only after the bridge listener exists. Warm responses
    // may otherwise execute before React hydrates and lose the handshake.
    load();
    return () => {
      disposed = true;
      window.removeEventListener("message", onMessage);
      iframe.removeEventListener("load", onLoad);
      revoke();
    };
    // The translator is read inside the relay on purpose: re-subscribing (and
    // re-setting the document) when its identity changes would reload the App.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appKey, previewDraftId, context.app.versionId]);

  return (
    <iframe
      ref={iframeRef}
      title={context.app.name}
      // Opaque origin: allow-scripts ONLY. No allow-same-origin (that would
      // re-grant the parent origin and defeat the whole isolation model).
      sandbox="allow-scripts"
      key={`${appKey}:${previewDraftId ?? context.app.versionId ?? "active"}`}
      style={{
        width: "100%",
        height: "100%",
        minHeight: "calc(100vh - 8rem)",
        border: "0",
        display: "block",
      }}
    />
  );
}
