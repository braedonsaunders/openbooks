# Translation glossary — openbooks UI catalogs

Canonical translations for recurring accounting/ERP terms, so every namespace
stays consistent across `web/messages/<locale>/*.json`. English is the source
of truth; missing keys fall back to English via `withEnglishFallback`.

## Rules for all translations
- Translate **values only**, never JSON keys.
- Preserve every ICU token exactly: `{name}`, `{count, plural, one {…} other {…}}`,
  `{kind, select, …}`, and rich-text tags like `<link>…</link>`, `<setup>…</setup>`.
  Do not translate variable names inside `{…}` or tag names.
- Keep `\n`, punctuation placeholders, and leading/trailing spaces.
- Match register: professional commercial SaaS. Japanese uses polite です/ます (敬体);
  German uses formal "Sie"; Portuguese is pt-BR (você), no Portugal-isms.
- Keep product/proper nouns as-is: openbooks, SFTP, PDF, API, OAuth, CSV, JSON,
  QuickBooks, NetSuite, Xero, Odoo, ERPNext, Benford.

## Core term map (en → de → pt-BR → zh → ja)
| English | de | pt-BR | zh | ja |
|---|---|---|---|---|
| Invoice (AR) | Ausgangsrechnung | Fatura | 发票 | 請求書 |
| Bill (AP) | Eingangsrechnung | Conta a pagar | 应付账单 | 仕入請求書 |
| Estimate / Quote | Angebot | Orçamento | 报价单 | 見積 |
| Sales order | Kundenauftrag | Pedido de venda | 销售订单 | 受注 |
| Purchase order | Bestellung | Pedido de compra | 采购订单 | 発注書 |
| Customer | Kunde | Cliente | 客户 | 得意先 |
| Vendor / Supplier | Lieferant | Fornecedor | 供应商 | 仕入先 |
| Journal / Journal entry | Journal / Buchung | Lançamento (contábil) | 日记账 / 分录 | 仕訳 |
| Chart of accounts | Kontenplan | Plano de contas | 会计科目表 | 勘定科目表 |
| Account | Konto | Conta | 科目 / 账户 | 勘定 / アカウント |
| Ledger / General ledger | Hauptbuch | Razão / Livro-razão | 总账 | 総勘定元帳 |
| Post / Posting | buchen / Buchung | lançar / lançamento | 过账 | 記帳 / 転記 |
| Reconcile / Reconciliation | abstimmen / Abstimmung | conciliar / conciliação | 对账 | 消込 / 照合 |
| Period close | Periodenabschluss | Fechamento de período | 期末结账 | 期末決算 |
| Payment | Zahlung | Pagamento | 付款 | 支払 |
| Receipt (customer payment) | Kundenzahlung / Zahlungseingang | Recebimento | 收款 | 入金 |
| Expense | Ausgabe | Despesa | 费用 | 経費 |
| Tax | Steuer | Imposto / Tributo | 税 | 税 |
| Debit / Credit | Soll / Haben | Débito / Crédito | 借方 / 贷方 | 借方 / 貸方 |
| Fixed asset | Anlagevermögen / Anlage | Ativo imobilizado | 固定资产 | 固定資産 |
| Depreciation | Abschreibung | Depreciação | 折旧 | 減価償却 |
| Budget | Budget | Orçamento (planejado) | 预算 | 予算 |
| Inventory / Stock | Lagerbestand | Estoque | 库存 | 在庫 |
| Revenue recognition | Umsatzrealisierung | Reconhecimento de receita | 收入确认 | 収益認識 |
| Approval | Genehmigung | Aprovação | 审批 | 承認 |
| Record (data) | Datensatz | Registro | 记录 | レコード |
| Record type | Datensatztyp | Tipo de registro | 记录类型 | レコードタイプ |
| Field | Feld | Campo | 字段 | フィールド |
| Report | Bericht | Relatório | 报表 | レポート |
| Dashboard | Dashboard | Painel | 仪表板 | ダッシュボード |
| Settings | Einstellungen | Configurações | 设置 | 設定 |
| Draft | Entwurf | Rascunho | 草稿 | 下書き |
| Login (SFTP credential) | Zugangsdaten / Login | Login | 登录账号 | ログイン |
| Endpoint | Endpunkt | Endpoint | 端点 | エンドポイント |
| Migration / Mirror | Migration / Spiegelung | Migração / Espelhamento | 迁移 / 镜像 | 移行 / ミラー |
| Organization (was "tenant") | Organisation | Organização | 组织 | 組織 |
