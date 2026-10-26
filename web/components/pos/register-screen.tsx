"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button, Input } from "@openbooks/ui";
import { cmp } from "@openbooks/engine/money/money";
import { promptDialog } from "../../lib/prompt";
import { useMoney } from "../money-provider";
import { DrawerPanel, OpenSessionPanel } from "./drawer-panel";
import { PaymentPanel } from "./payment-panel";
import { ReceiptPanel } from "./receipt-panel";
import { RefundPanel } from "./refund-panel";
import {
  newRequestKey,
  posRequest,
  PosRequestError,
  type PosCartLine,
  type PosCompletion,
  type PosDiscount,
  type PosPayment,
  type PosQuote,
  type PosRegisterContext,
} from "./pos-api";

type Panel = "sell" | "pay" | "receipt" | "refund" | "drawer" | "held";
type ItemHit = { id: string; code: string | null; name: string; kind: string; exact: boolean };
type CustomerHit = { id: string; name: string; email: string | null; phone: string | null };

/** "10%" is a percentage, "2.50" an amount; anything else is not a discount. */
function parseDiscount(raw: string): PosDiscount | null {
  const text = raw.trim();
  const percent = /^(\d{1,3}(\.\d{1,4})?)\s*%$/.exec(text);
  if (percent) return { kind: "percent", value: percent[1]! };
  if (/^\d{1,13}(\.\d{1,4})?$/.test(text)) return { kind: "amount", value: text };
  return null;
}

function describeDiscount(discount: PosDiscount, money: (value: string) => string): string {
  return discount.kind === "percent" ? `${discount.value}%` : money(discount.value);
}

/**
 * The register: a full-screen, touch-first selling surface over native cash
 * sales. The scan field keeps focus so a barcode scanner that types the item
 * code and Enter adds the item; the cart is priced by the server exactly as
 * the sale will post (native prices, discount proration and tax), and
 * checkout carries one request key per receipt so a retried submit never
 * rings the sale twice.
 */
export function RegisterScreen(props: {
  registerId: string;
  canRefund: boolean;
  canOverride: boolean;
  canManageDrawer: boolean;
  canViewSessions: boolean;
}) {
  const t = useTranslations("pos");
  const [context, setContext] = useState<PosRegisterContext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>("sell");
  const [lines, setLines] = useState<PosCartLine[]>([]);
  const [orderDiscount, setOrderDiscount] = useState<PosDiscount | null>(null);
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(null);
  const [pricedQuote, setQuote] = useState<PosQuote | null>(null);
  const [pricedFor, setQuoteFor] = useState(-1);
  const [cartVersion, setCartVersion] = useState(0);
  const [pricingError, setQuoteError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<ItemHit[]>([]);
  const [customerQuery, setCustomerQuery] = useState("");
  const [matchedCustomers, setCustomerHits] = useState<CustomerHit[]>([]);
  const [checkoutKey, setCheckoutKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [completion, setCompletion] = useState<PosCompletion | null>(null);
  const [heldCarts, setHeldCarts] = useState<
    Array<{ id: string; label: string; lineCount: number; heldAt: string; heldBy: string | null }>
  >([]);
  const scanRef = useRef<HTMLInputElement>(null);
  const currency = context?.register.currency;
  const { money } = useMoney(currency);

  // An empty cart has nothing to price: it is current at zero with no refusal.
  const cartEmpty = !context || lines.length === 0;
  const quote = cartEmpty ? null : pricedQuote;
  const quoteFor = cartEmpty ? cartVersion : pricedFor;
  const quoteError = cartEmpty ? null : pricingError;
  // A customer search starts at two characters; a shorter query lists no one.
  const customerHits = customerQuery.trim().length < 2 ? [] : matchedCustomers;

  const loadContext = useCallback(async () => {
    try {
      setContext(
        await posRequest<PosRegisterContext>(
          `/api/pos/registers/${props.registerId}`,
          {},
          t("errors.registerLoad"),
        ),
      );
      setLoadError(null);
    } catch (cause) {
      setLoadError(
        cause instanceof PosRequestError
          ? [cause.message, cause.remedy].filter(Boolean).join(" ")
          : t("errors.registerLoad"),
      );
    }
  }, [props.registerId, t]);

  useEffect(() => {
    let current = true;
    posRequest<PosRegisterContext>(
      `/api/pos/registers/${props.registerId}`,
      {},
      t("errors.registerLoad"),
    ).then(
      (loaded) => {
        if (!current) return;
        setContext(loaded);
        setLoadError(null);
      },
      (cause: unknown) => {
        if (current)
          setLoadError(
            cause instanceof PosRequestError
              ? [cause.message, cause.remedy].filter(Boolean).join(" ")
              : t("errors.registerLoad"),
          );
      },
    );
    return () => {
      current = false;
    };
  }, [props.registerId, t]);

  const focusScan = useCallback(() => {
    window.setTimeout(() => scanRef.current?.focus(), 0);
  }, []);

  const changeCart = useCallback((update: () => void) => {
    update();
    setCartVersion((version) => version + 1);
    setCheckoutKey(null);
  }, []);

  // Price the cart on the server whenever it changes, debounced so a burst
  // of scans asks once. The Pay button waits for the quote of this version.
  useEffect(() => {
    if (!context || lines.length === 0) return;
    const version = cartVersion;
    const timer = window.setTimeout(() => {
      posRequest<{ quote: PosQuote }>(
        "/api/pos/quote",
        {
          method: "POST",
          body: {
            registerId: context.register.id,
            customerId: customer?.id ?? null,
            lines: lines.map((line) => ({
              itemId: line.itemId,
              quantity: line.quantity,
              unitPrice: line.unitPrice,
              discount: line.discount,
            })),
            orderDiscount,
          },
        },
        t("errors.quote"),
      )
        .then((body) => {
          setQuote(body.quote);
          setQuoteFor(version);
          setQuoteError(null);
        })
        .catch((cause: unknown) => {
          setQuoteFor(version);
          setQuote(null);
          setQuoteError(
            cause instanceof PosRequestError
              ? [cause.message, cause.remedy].filter(Boolean).join(" ")
              : t("errors.quote"),
          );
        });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [cartVersion, context, customer, lines, orderDiscount, t]);

  function addItem(hit: { itemId: string; name: string; code: string | null }) {
    changeCart(() =>
      setLines((current) => {
        const existing = current.find(
          (line) => line.itemId === hit.itemId && !line.discount && line.unitPrice === null,
        );
        if (existing) {
          return current.map((line) =>
            line === existing
              ? { ...line, quantity: String(Number.parseInt(line.quantity, 10) + 1) }
              : line,
          );
        }
        return [
          ...current,
          {
            key: newRequestKey(),
            itemId: hit.itemId,
            name: hit.name,
            code: hit.code,
            quantity: "1",
            unitPrice: null,
            discount: null,
          },
        ];
      }),
    );
    setSearch("");
    setHits([]);
    focusScan();
  }

  async function runSearch(submit: boolean) {
    const q = search.trim();
    if (q === "") {
      setHits([]);
      return;
    }
    try {
      const body = await posRequest<{ items: ItemHit[] }>(
        `/api/pos/items?q=${encodeURIComponent(q)}`,
        {},
        t("errors.search"),
      );
      const exact = body.items.find((item) => item.exact);
      if (submit && (exact || body.items.length === 1)) {
        const item = exact ?? body.items[0]!;
        addItem({ itemId: item.id, name: item.name, code: item.code });
        return;
      }
      setHits(body.items);
      if (submit && body.items.length === 0) setNotice(t("scan.noMatch", { code: q }));
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : t("errors.search"));
    }
  }

  useEffect(() => {
    if (search.trim().length < 2) return;
    const timer = window.setTimeout(() => {
      void runSearch(false);
    }, 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- search text drives the lookup
  }, [search]);

  useEffect(() => {
    if (customerQuery.trim().length < 2) return;
    const timer = window.setTimeout(() => {
      posRequest<{ customers: CustomerHit[] }>(
        `/api/pos/customers?q=${encodeURIComponent(customerQuery.trim())}`,
        {},
        t("errors.search"),
      )
        .then((body) => setCustomerHits(body.customers))
        .catch(() => setCustomerHits([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [customerQuery, t]);

  function setQuantity(key: string, quantity: string) {
    changeCart(() =>
      setLines((current) =>
        current.map((line) => (line.key === key ? { ...line, quantity } : line)),
      ),
    );
  }

  function bump(key: string, delta: number) {
    const line = lines.find((entry) => entry.key === key);
    if (!line) return;
    const whole = /^\d+$/.test(line.quantity) ? Number.parseInt(line.quantity, 10) : null;
    if (whole === null) return;
    const next = whole + delta;
    if (next <= 0)
      changeCart(() => setLines((current) => current.filter((entry) => entry.key !== key)));
    else setQuantity(key, String(next));
    focusScan();
  }

  async function editQuantity(line: PosCartLine) {
    const value = await promptDialog({
      title: t("cart.quantityTitle", { item: line.name }),
      initialValue: line.quantity,
      confirmLabel: t("actions.apply"),
    });
    if (value === null) return focusScan();
    if (!/^\d{1,9}(\.\d{1,4})?$/.test(value) || cmp(value, "0") <= 0) {
      setNotice(t("cart.invalidQuantity"));
    } else {
      setQuantity(line.key, value);
    }
    focusScan();
  }

  async function editPrice(line: PosCartLine) {
    const value = await promptDialog({
      title: t("cart.priceTitle", { item: line.name }),
      message: t("cart.priceHelp"),
      initialValue: line.unitPrice ?? "",
      confirmLabel: t("actions.apply"),
    });
    if (value === null) return focusScan();
    if (value.trim() !== "" && !/^\d{1,13}(\.\d{1,4})?$/.test(value.trim()))
      setNotice(t("cart.invalidPrice"));
    else
      changeCart(() =>
        setLines((current) =>
          current.map((entry) =>
            entry.key === line.key
              ? { ...entry, unitPrice: value.trim() === "" ? null : value.trim() }
              : entry,
          ),
        ),
      );
    focusScan();
  }

  async function editDiscount(line: PosCartLine | null) {
    const current = line ? line.discount : orderDiscount;
    const value = await promptDialog({
      title: line ? t("cart.lineDiscountTitle", { item: line.name }) : t("cart.orderDiscountTitle"),
      message: t("cart.discountHelp"),
      initialValue: current
        ? current.kind === "percent"
          ? `${current.value}%`
          : current.value
        : "",
      confirmLabel: t("actions.apply"),
    });
    if (value === null) return focusScan();
    const parsed = value.trim() === "" ? null : parseDiscount(value);
    if (value.trim() !== "" && !parsed) {
      setNotice(t("cart.invalidDiscount"));
    } else if (line) {
      changeCart(() =>
        setLines((all) =>
          all.map((entry) => (entry.key === line.key ? { ...entry, discount: parsed } : entry)),
        ),
      );
    } else {
      changeCart(() => setOrderDiscount(parsed));
    }
    focusScan();
  }

  function resetSale() {
    changeCart(() => {
      setLines([]);
      setOrderDiscount(null);
      setCustomer(null);
    });
    setCompletion(null);
    setPanel("sell");
    setNotice(null);
    focusScan();
  }

  async function checkout(payments: PosPayment[]) {
    if (!context?.session || !quote) return;
    // One key per receipt attempt: a lost response retries with the same key
    // and receives the sale already recorded; a refusal starts a new attempt.
    const key = checkoutKey ?? newRequestKey();
    setCheckoutKey(key);
    setBusy(true);
    setNotice(null);
    try {
      const result = await posRequest<PosCompletion>(
        "/api/pos/sales",
        {
          method: "POST",
          idempotencyKey: key,
          body: {
            sessionId: context.session.id,
            customerId: customer?.id ?? null,
            lines: lines.map((line) => ({
              itemId: line.itemId,
              quantity: line.quantity,
              unitPrice: line.unitPrice,
              discount: line.discount,
            })),
            orderDiscount,
            payments,
            expectedTotal: quote.total,
          },
        },
        t("errors.sale"),
      );
      setCompletion(result);
      setPanel("receipt");
    } catch (cause) {
      if (cause instanceof PosRequestError && !cause.retryable) setCheckoutKey(null);
      if (cause instanceof PosRequestError && cause.code === "total_changed") {
        setCartVersion((version) => version + 1);
        setPanel("sell");
      }
      setNotice(
        cause instanceof PosRequestError
          ? [cause.message, cause.retryable ? t("errors.retrySafe") : cause.remedy]
              .filter(Boolean)
              .join(" ")
          : t("errors.sale"),
      );
    } finally {
      setBusy(false);
    }
  }

  async function holdCurrent() {
    if (!context || lines.length === 0) return;
    const label = await promptDialog({
      title: t("held.holdTitle"),
      label: t("held.label"),
      initialValue: customer?.name ?? "",
      confirmLabel: t("held.hold"),
    });
    if (!label) return focusScan();
    try {
      await posRequest(
        `/api/pos/registers/${context.register.id}/held-carts`,
        {
          method: "POST",
          body: {
            label,
            cart: {
              customerId: customer?.id ?? null,
              lines: lines.map((line) => ({
                itemId: line.itemId,
                quantity: line.quantity,
                unitPrice: line.unitPrice,
                discount: line.discount,
              })),
              orderDiscount,
            },
          },
        },
        t("errors.hold"),
      );
      resetSale();
      setNotice(t("held.held", { label }));
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : t("errors.hold"));
    }
  }

  async function openHeld() {
    if (!context) return;
    try {
      const body = await posRequest<{ carts: typeof heldCarts }>(
        `/api/pos/registers/${context.register.id}/held-carts`,
        {},
        t("errors.hold"),
      );
      setHeldCarts(body.carts);
      setPanel("held");
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : t("errors.hold"));
    }
  }

  async function resume(cartId: string) {
    if (!context) return;
    try {
      const body = await posRequest<{
        cart: {
          customerId: string | null;
          customerName: string | null;
          lines: Array<{
            itemId: string;
            quantity: string;
            unitPrice?: string | null;
            discount?: PosDiscount | null;
          }>;
          orderDiscount?: PosDiscount | null;
          items: Record<string, { name: string; code: string | null }>;
        };
      }>(
        `/api/pos/registers/${context.register.id}/held-carts/${cartId}/resume`,
        { method: "POST" },
        t("errors.hold"),
      );
      const cart = body.cart;
      changeCart(() => {
        setLines(
          cart.lines.map((line) => ({
            key: newRequestKey(),
            itemId: line.itemId,
            name: cart.items[line.itemId]?.name ?? t("held.item"),
            code: cart.items[line.itemId]?.code ?? null,
            quantity: line.quantity,
            unitPrice: line.unitPrice ?? null,
            discount: line.discount ?? null,
          })),
        );
        setOrderDiscount(cart.orderDiscount ?? null);
        setCustomer(
          cart.customerId
            ? { id: cart.customerId, name: cart.customerName ?? t("held.customer") }
            : null,
        );
      });
      setPanel("sell");
      focusScan();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : t("errors.hold"));
    }
  }

  if (loadError) {
    return (
      <div className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-white p-6 dark:bg-slate-950">
        <p className="max-w-lg text-center text-lg">{loadError}</p>
        <Button asChild variant="outline">
          <Link href="/pos">{t("actions.exit")}</Link>
        </Button>
      </div>
    );
  }
  if (!context) {
    return (
      <div className="fixed inset-0 z-40 flex items-center justify-center bg-white text-slate-500 dark:bg-slate-950">
        {t("register.loading")}
      </div>
    );
  }

  const session = context.session;
  const quoteCurrent = quote !== null && quoteFor === cartVersion;
  const quoteLine = (index: number) => (quoteCurrent ? quote.lines[index] : undefined);

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-900">
        <div className="min-w-0">
          <p className="truncate font-semibold">
            {context.register.code} · {context.register.name}
          </p>
          <p className="text-xs text-slate-500">
            {session
              ? t("register.sessionOpen", {
                  number: session.sessionNumber,
                  date: session.businessDate,
                })
              : t("register.sessionClosed")}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {session && panel === "sell" ? (
            <Button variant="outline" onClick={() => void openHeld()}>
              {t("held.title")}
            </Button>
          ) : null}
          {session && props.canRefund && panel === "sell" ? (
            <Button variant="outline" onClick={() => setPanel("refund")}>
              {t("refund.title")}
            </Button>
          ) : null}
          {session && props.canManageDrawer && panel === "sell" ? (
            <Button variant="outline" onClick={() => setPanel("drawer")}>
              {t("session.drawer")}
            </Button>
          ) : null}
          {props.canViewSessions ? (
            <Button asChild variant="ghost">
              <Link href="/pos/sessions">{t("session.history")}</Link>
            </Button>
          ) : null}
          <Button asChild variant="ghost">
            <Link href="/pos">{t("actions.exit")}</Link>
          </Button>
        </div>
      </header>
      {notice ? (
        <div
          role="status"
          className="flex items-center justify-between gap-3 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
        >
          <span>{notice}</span>
          <Button variant="ghost" size="sm" onClick={() => setNotice(null)}>
            {t("actions.dismiss")}
          </Button>
        </div>
      ) : null}
      {!session ? (
        <main className="flex-1 overflow-y-auto p-6">
          <OpenSessionPanel
            context={context}
            canManageDrawer={props.canManageDrawer}
            onOpened={() => {
              void loadContext();
              focusScan();
            }}
          />
        </main>
      ) : panel === "drawer" ? (
        <main className="flex-1 overflow-y-auto p-6">
          <DrawerPanel
            context={context}
            onBack={() => {
              setPanel("sell");
              focusScan();
            }}
            onClosed={() => {
              resetSale();
              void loadContext();
            }}
          />
        </main>
      ) : panel === "refund" ? (
        <main className="flex-1 overflow-hidden p-6">
          <RefundPanel
            context={context}
            sessionId={session.id}
            onCancel={() => {
              setPanel("sell");
              focusScan();
            }}
            onRefunded={(result) => {
              setCompletion(result);
              setPanel("receipt");
            }}
          />
        </main>
      ) : panel === "receipt" && completion ? (
        <main className="flex-1 overflow-hidden p-6">
          <ReceiptPanel
            documentId={completion.documentId}
            change={completion.kind === "sale" ? completion.change : null}
            onDone={resetSale}
          />
        </main>
      ) : panel === "held" ? (
        <main className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-xl space-y-3">
            <h2 className="text-xl font-semibold">{t("held.title")}</h2>
            {heldCarts.length === 0 ? <p className="text-slate-500">{t("held.empty")}</p> : null}
            <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
              {heldCarts.map((cart) => (
                <li key={cart.id} className="flex items-center justify-between gap-3 px-3 py-3">
                  <span>
                    <span className="font-medium">{cart.label}</span>
                    <span className="block text-xs text-slate-500">
                      {cart.heldBy
                        ? t("held.summaryBy", { count: cart.lineCount, by: cart.heldBy })
                        : t("held.summary", { count: cart.lineCount })}
                    </span>
                  </span>
                  <Button
                    size="lg"
                    disabled={lines.length > 0}
                    onClick={() => void resume(cart.id)}
                  >
                    {t("held.resume")}
                  </Button>
                </li>
              ))}
            </ul>
            {lines.length > 0 ? (
              <p className="text-sm text-slate-500">{t("held.finishCurrent")}</p>
            ) : null}
            <Button
              variant="outline"
              size="lg"
              onClick={() => {
                setPanel("sell");
                focusScan();
              }}
            >
              {t("actions.back")}
            </Button>
          </div>
        </main>
      ) : (
        <main className="grid flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[3fr_2fr]">
          <section className="flex min-h-0 flex-col gap-3 overflow-hidden p-4">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void runSearch(true);
              }}
            >
              <Input
                ref={scanRef}
                autoFocus
                aria-label={t("scan.label")}
                className="h-14 text-lg"
                placeholder={t("scan.placeholder")}
                value={search}
                disabled={panel === "pay"}
                onChange={(event) => setSearch(event.target.value)}
              />
            </form>
            {hits.length > 0 ? (
              <ul className="max-h-64 divide-y divide-slate-200 overflow-y-auto rounded-lg border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
                {hits.map((hit) => (
                  <li key={hit.id}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between px-3 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
                      onClick={() => addItem({ itemId: hit.id, name: hit.name, code: hit.code })}
                    >
                      <span>{hit.name}</span>
                      <span className="text-xs text-slate-500">{hit.code}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="grid flex-1 auto-rows-[5.5rem] grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3 xl:grid-cols-4">
              {context.quickKeys.map((key) => (
                <button
                  key={key.itemId}
                  type="button"
                  disabled={panel === "pay"}
                  className="rounded-xl border border-slate-200 bg-white p-3 text-left text-base font-medium shadow-sm active:bg-teal-50 disabled:opacity-50 dark:border-slate-800 dark:bg-slate-900 dark:active:bg-teal-950"
                  onClick={() => addItem({ itemId: key.itemId, name: key.label, code: key.code })}
                >
                  {key.label}
                  {key.code ? (
                    <span className="block text-xs font-normal text-slate-500">{key.code}</span>
                  ) : null}
                </button>
              ))}
              {context.quickKeys.length === 0 ? (
                <p className="col-span-full text-sm text-slate-500">{t("scan.noQuickKeys")}</p>
              ) : null}
            </div>
          </section>
          <section className="flex min-h-0 flex-col border-l border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            {panel === "pay" && quoteCurrent ? (
              <div className="flex-1 overflow-y-auto p-4">
                <PaymentPanel
                  currency={quote.currency}
                  currencyDecimals={quote.currencyDecimals}
                  total={quote.total}
                  accepted={context.acceptedTenders}
                  busy={busy}
                  onCancel={() => {
                    setPanel("sell");
                    focusScan();
                  }}
                  onComplete={(payments) => void checkout(payments)}
                />
              </div>
            ) : (
              <>
                <div className="border-b border-slate-200 p-3 dark:border-slate-800">
                  {customer ? (
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{customer.name}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => changeCart(() => setCustomer(null))}
                      >
                        {t("customer.clear")}
                      </Button>
                    </div>
                  ) : (
                    <div className="relative">
                      <Input
                        aria-label={t("customer.search")}
                        placeholder={
                          context.defaultCustomerName
                            ? t("customer.walkInNamed", { name: context.defaultCustomerName })
                            : t("customer.walkIn")
                        }
                        value={customerQuery}
                        onChange={(event) => setCustomerQuery(event.target.value)}
                      />
                      {customerHits.length > 0 ? (
                        <ul className="absolute z-10 mt-1 max-h-60 w-full divide-y divide-slate-200 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
                          {customerHits.map((hit) => (
                            <li key={hit.id}>
                              <button
                                type="button"
                                className="w-full px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
                                onClick={() => {
                                  changeCart(() => setCustomer({ id: hit.id, name: hit.name }));
                                  setCustomerQuery("");
                                  setCustomerHits([]);
                                  focusScan();
                                }}
                              >
                                {hit.name}
                                <span className="block text-xs text-slate-500">
                                  {[hit.email, hit.phone].filter(Boolean).join(" · ")}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  )}
                </div>
                <ul className="flex-1 divide-y divide-slate-200 overflow-y-auto dark:divide-slate-800">
                  {lines.length === 0 ? (
                    <li className="p-6 text-center text-slate-500">{t("cart.empty")}</li>
                  ) : null}
                  {lines.map((line, index) => {
                    const priced = quoteLine(index);
                    return (
                      <li key={line.key} className="space-y-1 px-3 py-2">
                        <div className="flex items-start justify-between gap-2">
                          <button
                            type="button"
                            className="min-w-0 text-left"
                            onClick={() => void editQuantity(line)}
                          >
                            <span className="block truncate font-medium">{line.name}</span>
                            <span className="text-xs text-slate-500">
                              {line.quantity} × {priced ? money(priced.unitPrice) : "…"}
                              {priced?.priceOverridden ? ` · ${t("cart.overridden")}` : ""}
                              {line.discount ? ` · −${describeDiscount(line.discount, money)}` : ""}
                            </span>
                          </button>
                          <span className="font-semibold">{priced ? money(priced.net) : "…"}</span>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={t("cart.decrease")}
                            onClick={() => bump(line.key, -1)}
                          >
                            −
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={t("cart.increase")}
                            onClick={() => bump(line.key, 1)}
                          >
                            +
                          </Button>
                          {props.canOverride ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void editDiscount(line)}
                            >
                              {t("cart.discount")}
                            </Button>
                          ) : null}
                          {props.canOverride ? (
                            <Button variant="ghost" size="sm" onClick={() => void editPrice(line)}>
                              {t("cart.price")}
                            </Button>
                          ) : null}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              changeCart(() =>
                                setLines((all) => all.filter((entry) => entry.key !== line.key)),
                              )
                            }
                          >
                            {t("actions.remove")}
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                <div className="space-y-2 border-t border-slate-200 p-3 dark:border-slate-800">
                  {quoteError ? <p className="text-sm text-red-600">{quoteError}</p> : null}
                  <dl className="space-y-1 text-sm">
                    <div className="flex justify-between">
                      <dt>{t("totals.items")}</dt>
                      <dd>{quoteCurrent ? money(quote.gross) : "…"}</dd>
                    </div>
                    {quoteCurrent && cmp(quote.discount, "0") !== 0 ? (
                      <div className="flex justify-between">
                        <dt>{t("totals.discount")}</dt>
                        <dd>−{money(quote.discount)}</dd>
                      </div>
                    ) : null}
                    <div className="flex justify-between">
                      <dt>{t("totals.tax")}</dt>
                      <dd>{quoteCurrent ? money(quote.tax) : "…"}</dd>
                    </div>
                    <div className="flex justify-between text-2xl font-bold">
                      <dt>{t("totals.total")}</dt>
                      <dd>
                        {quoteCurrent ? money(quote.total) : lines.length === 0 ? money("0") : "…"}
                      </dd>
                    </div>
                  </dl>
                  <div className="flex gap-2">
                    {props.canOverride ? (
                      <Button
                        variant="outline"
                        disabled={lines.length === 0}
                        onClick={() => void editDiscount(null)}
                      >
                        {orderDiscount
                          ? t("cart.orderDiscountSet", {
                              value: describeDiscount(orderDiscount, money),
                            })
                          : t("cart.orderDiscount")}
                      </Button>
                    ) : null}
                    <Button
                      variant="outline"
                      disabled={lines.length === 0}
                      onClick={() => void holdCurrent()}
                    >
                      {t("held.hold")}
                    </Button>
                    <Button variant="ghost" disabled={lines.length === 0} onClick={resetSale}>
                      {t("cart.clear")}
                    </Button>
                  </div>
                  {/* A sale discounted or comped in full has nothing to tender: it completes directly, with no payment. */}
                  <Button
                    size="lg"
                    className="h-16 w-full text-xl"
                    disabled={!quoteCurrent || lines.length === 0 || busy}
                    onClick={() =>
                      quoteCurrent && cmp(quote.total, "0") === 0
                        ? void checkout([])
                        : setPanel("pay")
                    }
                  >
                    {quoteCurrent
                      ? cmp(quote.total, "0") === 0
                        ? t("cart.completeNoCharge")
                        : t("cart.pay", { amount: money(quote.total) })
                      : t("cart.pricing")}
                  </Button>
                </div>
              </>
            )}
          </section>
        </main>
      )}
    </div>
  );
}
