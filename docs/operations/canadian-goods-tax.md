# Canadian goods tax on invoices

Customer invoices can select **Native goods tax** in their existing record drawer. This election covers ordinary fully taxable tangible goods. It requires an explicit statutory delivery province, a delivery arrangement and contractual evidence. The billing address alone does not establish place of supply. For supplier-arranged shipment, assess the destination under the applicable GST/HST shipping rules; collection follows where the goods are made available.

Install the current Canada tax pack through Tax → Setup. Configure each applicable tax code's collected-tax liability account and its effective statutory rate. On Registrations, assign the selling legal entity, registration number and effective coverage. Existing organization-wide registrations remain preserved but require a deliberate legal-entity assignment before automatic selection. In a company with one active legal entity, the invoice uses that entity; companies with several must explicitly select the seller.

For unprofiled lines, the server selects GST or HST and applicable provincial standard taxes from the maintained dated pack. An explicit line code, group or tax override takes precedence. Services, exempt or zero-rated supplies, exports and special supplies require their own assessed explicit profile. This workflow does not infer exemption eligibility, registration obligations or contractual delivery terms from an address.

Saving freezes the selection, seller, date, amount, item classification, pack version, registrations, tax configuration and components for each automatically calculated line. The locked writer rechecks the calculation before persisting it. Posting rechecks that evidence again. Changed or missing sources refuse posting by name: return the invoice to draft, review the assessment and recalculate through the native editor. Posted evidence and the used registration identity remain immutable; controlled reversals correct posted invoices.

Tax filing uses the selected registration's legal entity. A registration cannot lend its number to another entity or to an aggregate return covering several entities. The existing filing preview, export and snapshot workflow carries the resolved registration and entity. Choose a registration when several active registrations share a return form.

Statutory reference: [CRA GST/HST place-of-supply guidance](https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-place-supply.html).
