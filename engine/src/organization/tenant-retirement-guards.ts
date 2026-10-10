/** Published DELETE contracts; unknown live guards refuse retirement. */
export const TENANT_RETIREMENT_GUARDS = [
  {
    "name": "account_group_member_scope_guard",
    "source": "0081_account_group_member_dimension_uniqueness.sql",
    "sha256": "b8db48d7a8cdb9c49acae2c77d6e6a704b48048fc65dfaf990de31548ff78c07",
    "newSha256": "8a84115166d66987d60c431cae362f4627e948b8acf154c95ebe330cdf001b70",
    "patch": true
  },
  {
    "name": "aging_bucket_policies_history_guard",
    "source": "0564_aging_bucket_policies.sql",
    "sha256": "4067b502751ace3e857d9c6ea7817d9f3bcb9f721be2b42ff26e529aac1d013d",
    "newSha256": "1946848eedc0d0f54a6d193d0a41d4edfa69518fdcf3cc161db2471948b81e73",
    "patch": true
  },
  {
    "name": "ai_decisions_refuse_update",
    "source": "0232_hrm_ai_rails.sql",
    "sha256": "17d4a505a911195abfd7003adc52cac5e594ddb3aaecfdd0538c6b7a9afa1cc6",
    "newSha256": "c9374b3f6a7765ef446e4f1066fa0dac74454e7fa77c0bae395fc6f0b3755c7e",
    "patch": true
  },
  {
    "name": "allocation_rule_target_guard",
    "source": "0160_allocation_kernel.sql",
    "sha256": "07861afc255fe326961adbb56bf57048fb6962fe72cdb4bbda22a19b8c369afb",
    "newSha256": "a76d7247d768665eb76f5455831eaaf96cda4045865a3d571681ba645a564b81",
    "patch": true
  },
  {
    "name": "application_evidence_guard",
    "source": "0001_baseline.sql",
    "sha256": "640590285e359e7b20b5829ec0e61d0e4c1258434c122c19c694398be05b60c6",
    "newSha256": "c16fedc72f2ff8b33001354bf4855051439877b3989348ba6ebb39b000775804",
    "patch": true
  },
  {
    "name": "assembly_disassembly_immutable",
    "source": "0460_assembly_disassembly_evidence.sql",
    "sha256": "5e180e04bc50599a5c050d647b7d1f3e080ac0b906630ad5612f1f1c5c59f95f",
    "newSha256": "1b4a0e915d028f4b4c92fb9b2315f900dce5d16dde89a81744e2e03434381a52",
    "patch": true
  },
  {
    "name": "asset_basis_change_guard",
    "source": "0204_asset_lifecycle_changes.sql",
    "sha256": "0af1fdaeb48e01f5e93a42461767d2f6b3f4f16e375e423c3f2b1c5aeaa6d26f",
    "newSha256": "17b8aaab04b84402f040d637ce2f5aaee602ea0a3bcaebdc0998d9ba0916398f",
    "patch": true
  },
  {
    "name": "asset_event_append_only_guard",
    "source": "0204_asset_lifecycle_changes.sql",
    "sha256": "bdd572c4ca080375868712c25771e1b0fc39e998f6daa08fd4450f0cd343d7bc",
    "newSha256": "331a4100ee55d054476ff0f9fecfb2322c0159b27e725bc10eb0aa91110dbaff",
    "patch": true
  },
  {
    "name": "asset_transfer_history_guard",
    "source": "0204_asset_lifecycle_changes.sql",
    "sha256": "d6d9f0067f87d518d9e6c47e4dbc7754cd7d2eac2dd1c264f97f00d468980fae",
    "newSha256": "38879e83f23afe9d0cdb1cb081cf10bb6da5fea6f8a15823edadfaddb1d8b16b",
    "patch": true
  },
  {
    "name": "asset_transfer_measurement_guard",
    "source": "0204_asset_lifecycle_changes.sql",
    "sha256": "c046ae4f5d4b1de3b14fc13eab6d35cddf62e338cf16f8d0f745bad3ef2408c6",
    "newSha256": "c174dfd679cd370891b96ca7f95f486396606f6bb1b3b6c5e8e3f14225563ff5",
    "patch": true
  },
  {
    "name": "audit_log_append_only_guard",
    "source": "0001_baseline.sql",
    "sha256": "f967cf9e24ef97c248702e260b1427af33f03373a177932b5f8f8e76a801a52f",
    "newSha256": "4d4625231d852dad26b006891b9400173ec28c4afac3c5a601bbff3e41868c4c",
    "patch": true
  },
  {
    "name": "benefit_catalog_identity_guard",
    "source": "0482_benefit_program_identity.sql",
    "sha256": "ddd4725a1304750928d9c6e6620bbbe565ff3e0e26a3853194cd9ff0482f7340",
    "newSha256": "d38bdaaeaa6622cd6e341e352b738865f346bf38192d86abb62a03409cd67248",
    "patch": true
  },
  {
    "name": "benefit_recovery_source_guard",
    "source": "0478_benefit_recovery_policy_windows.sql",
    "sha256": "f37d235326917c0c15c4b38d8702a53991a900ef3fcac5090124876fc8002b73",
    "newSha256": "385b73e95f2a0a793a62cdd1d005940cfda17d9995f162fce06d2ac95d4887a5",
    "patch": true
  },
  {
    "name": "benefit_recurring_audit",
    "source": "0476_benefit_recurring_contributions.sql",
    "sha256": "08224f95861dda28c8948555fe08e5e1365f5eff3f234f04d01a70f57e29aa4b",
    "newSha256": "2bb2d1b15b48142adeb8a29e3711dad3e0c00165998179f355cb017710ebd266",
    "patch": true
  },
  {
    "name": "benefit_recurring_configuration_lock",
    "source": "0476_benefit_recurring_contributions.sql",
    "sha256": "3c2cc633a7f9c97ad5a0a053af3feba41198c81f28cf3f59c3b3ffaa1d059d5d",
    "newSha256": "51537522674abf1bb665627205e826da5560552cfee5d42b9d4cef0878307bea",
    "patch": true
  },
  {
    "name": "benefit_recurring_history_guard",
    "source": "0478_benefit_recovery_policy_windows.sql",
    "sha256": "793d6fdad77cc049dbcbef527f2cf834a988f6a83a2a89f08d8887c6e2cbd047",
    "newSha256": "22a9285f207dbfaaa3d7c4656e789a176becf387f5d00bc59f0daf6a911af4d9",
    "patch": true
  },
  {
    "name": "benefit_transaction_rule_audit",
    "source": "0570_benefit_transaction_policies.sql",
    "sha256": "eb613751fdcb8ca17ac695cbf498f5b675618957a656adff4a4c9ea415d91016",
    "newSha256": "fcb03068f7bbefba435a45bb245cd8aaf46040eb81ab4651b92f37dcaa03c0f0",
    "patch": true
  },
  {
    "name": "benefit_transaction_rule_guard",
    "source": "0570_benefit_transaction_policies.sql",
    "sha256": "7ad7733994a255e302b12421dc613f0dbd130c2a8aacc7534e5eb55d8292b39f",
    "newSha256": "57293769559fd70a48e0e8c07999d20a66e47ed74906b5d429f67c4033273675",
    "patch": true
  },
  {
    "name": "billing_request_field_ticket_guard",
    "source": "0001_baseline.sql",
    "sha256": "acf2a880a891bcb9c5e931d043caf59303ccc52735000e4f7fc1fa1317bb3597",
    "newSha256": "c6c7b606e07b4304b3e1c809f0e59a332943a05178a880bee95e1f5be65b59fb",
    "patch": true
  },
  {
    "name": "change_set_items_lifecycle_guard",
    "source": "0066_change_set_review_approval_audit.sql",
    "sha256": "06f343912fad3f4efc81b104ef8e5b45633e1536e060fa74d5835ea422ba39f4",
    "newSha256": "a777f1f80e050826e743804bc67570fce1a1439815aaa3bb9c1c342b13e9c75d",
    "patch": true
  },
  {
    "name": "close_append_only_guard",
    "source": "0001_baseline.sql",
    "sha256": "132e82b2ff7110a2d235bc0497cf4024dd90878ca65878757cf55a9c882bb62c",
    "newSha256": "48e2596392cb0a66511cbac3b147ff072a28b82b55b0b4cc00fb02f6a8fb4e65",
    "patch": true
  },
  {
    "name": "consignment_event_immutable",
    "source": "0615_inventory_stock_controls.sql",
    "sha256": "bc1a103905c6c322c0391a0a332d42d3b8b2d8783fcbba1a635993e10c3c1498",
    "newSha256": "c92cfd2fac4ffc1ddcec3651bb6e571d7cab454659bc1a016ddac01cef27c866",
    "patch": true
  },
  {
    "name": "consignment_position_guard",
    "source": "0616_serial_count_restoration.sql",
    "sha256": "2c31ff454310fbacf06669960649af3e9034364b0d5b5efc1d51ee13b589ac64",
    "newSha256": "4100fb08bf8f48fd849763e85842413c836e2658cf8ef4e75c7c8e88108c22e3",
    "patch": true
  },
  {
    "name": "contract_cost_amortization_immutable",
    "source": "0505_contract_costs.sql",
    "sha256": "a56c4bd065e2ee780487f6b5943ff51156b109e37e6ade1ff83c8581c5eb8728",
    "newSha256": "4e6f370f61abd4c4bbe617e897d6a537768650f72204544f11ce3fbdfca1de8d",
    "patch": true
  },
  {
    "name": "control_loss_history_guard",
    "source": "0205_consolidation_loss_of_control.sql",
    "sha256": "3ab7835d7e8a3304c55ea91e84ae172a99fc1c0de0574efec1ca03b95d2b1443",
    "newSha256": "5266c018353fdf9adc114990f626d4529ed8161d0015b1dbc957296563eacb87",
    "patch": true
  },
  {
    "name": "control_loss_source_guard",
    "source": "0205_consolidation_loss_of_control.sql",
    "sha256": "b6bb6b5124c427da7efcc4d12c4b4d266a54e46526ed4a46a4c33f86883e928b",
    "newSha256": "b7730e245e30e208584e5d9024d7b96a4bcb162cf207e19123844021ffff3211",
    "patch": true
  },
  {
    "name": "data_transfer_evidence_guard",
    "source": "0472_durable_data_transfers.sql",
    "sha256": "1d0c887654ca89ef8470e2152f56b37403810e7760958fe3a7aa6d2cf7257968",
    "newSha256": "9ca4a5ce34e6c6da2654695f47816a8a35d4051f80701edc8d80e59d52406c9d",
    "patch": true
  },
  {
    "name": "depreciation_book_policy_history_guard",
    "source": "0103_depreciation_book_policy_history.sql",
    "sha256": "e16e0cd56bc9d75047d424b781dd75450c8e8abc4014c7fd66aadc3ccd9af506",
    "newSha256": "7892ecbd58cd9d812d54be62b0860ae62dcd9293bb790013fbe6b39d415e0f68",
    "patch": true
  },
  {
    "name": "depreciation_evidence_attachment_guard",
    "source": "0078_sandbox_wipe_guard_authorization.sql",
    "sha256": "3465bb85d39e791912ca0181bf1ef3f4dfd92248928a1d2756b1f319c9161336",
    "newSha256": "fd91428a38d7d5a08823ea70ba1b291842e40362e3e4165cf471e27c7f651617",
    "patch": true
  },
  {
    "name": "depreciation_non_gl_recognition_guard",
    "source": "0316_clone_closed_period_authority.sql",
    "sha256": "14eb7f2c951cef9c7bdca54760df06cd421276989d626da8110763ad1e2a5c43",
    "newSha256": "98f0f2ebeb8fd7f04da8aa26762a39cb2f26472011149734c7c1004da843a759",
    "patch": true
  },
  {
    "name": "document_correction_lineage_guard",
    "source": "0001_baseline.sql",
    "sha256": "53c4bf5463281582bdcd0f3026e8c63737b272b09ecec6093f968f6ae8f45724",
    "newSha256": "fe596d8052e38f65f576e50c8db7a246dd4aa767003839d4e131f7f1f283b11c",
    "patch": true
  },
  {
    "name": "document_line_immutability_guard",
    "source": "0148_replay_before_parent_lookup.sql",
    "sha256": "d06b3e1236ebaa95855d1132723dcb55e7957437f2a8a53acdc6cffa901be04a",
    "newSha256": "9e5f4e7b5262ead439abf1da76275c0f436df16b8ae16697f109446cd9c4ac24",
    "patch": true
  },
  {
    "name": "document_line_tax_component_guard",
    "source": "0001_baseline.sql",
    "sha256": "b1831e424f816cb63924282dcd22a967f6485e59329986c60880afc199a2772e",
    "newSha256": "a1543f16ab602143fb032b7e7f9ff28dd0be0432f450d0ea0c6d39e486bbe1d4",
    "patch": true
  },
  {
    "name": "document_lines_total_line_refresh",
    "source": "0078_sandbox_wipe_guard_authorization.sql",
    "sha256": "d1623ae509c1cfc304086598a3a6f287505dc0e8bb2cc4dfdd6a4f6e05bcdd68",
    "newSha256": "04bd8dbe66b8d765b18e613c670d360bc0e88bdb995070ef30705ccd2801c683",
    "patch": true
  },
  {
    "name": "document_lines_total_line_tieout",
    "source": "0078_sandbox_wipe_guard_authorization.sql",
    "sha256": "1eeaa2d01ca04776a163c0a0162834ebd108bb877a19fbb8deb8277706b1d860",
    "newSha256": "8e9476b24463f9311891f64627d3c72ad2021f462f51c91c5f8357bc40682130",
    "patch": true
  },
  {
    "name": "document_supply_evidence_guard",
    "source": "0521_supply_evidence_maintenance.sql",
    "sha256": "f6a3b4e9550a4c2fb89e63af6d212a77a7bd49c2430914157a87782f5bd11f0c",
    "newSha256": "d0fe78f258761f3b0a5c75a2292299ac4358b51330966cfa3982f1f6bb16ae7d",
    "patch": true
  },
  {
    "name": "document_tender_lifecycle_guard",
    "source": "0494_document_tenders.sql",
    "sha256": "e3dac2e05969507c1e1cabcb088747b57e4add65d2bc2d61d54fb028d5a324d4",
    "newSha256": "ae7badc6a311b1bd9a9df3dde8d74b33e7c5622ba63561c38458dc133bee25c2",
    "patch": true
  },
  {
    "name": "drop_ship_allocation_guard",
    "source": "0464_drop_ship_agency.sql",
    "sha256": "584b94d271c0b4668201e185d19fc70a0fdd966e76cf648d304b6c1670982c21",
    "newSha256": "0ccbb1be53311a0a7cf9d06e2f07b3b3e9cd86c2cdf3a06e98d6c76da4cbe465",
    "patch": true
  },
  {
    "name": "dunning_log_guard",
    "source": "0404_sandbox_wipe_dunning_guard.sql",
    "sha256": "38e04df233701c25a964f99c50c2bf136d1a161b337a7ea8592e2fed0f42d2ab",
    "newSha256": "d75214276f419d5452ae74884ee0adceef5e22c62f48547fb90a62480c1ae688",
    "patch": true
  },
  {
    "name": "einvoice_documents_immutable",
    "source": "0598_einvoicing.sql",
    "sha256": "f1a208ddc016726dcb8e80528f04b1b6ed11a86f17da03a5bab05e9cb8d901ae",
    "newSha256": "9221b0026514f83adc4ddc637a1ba841972182d5c712c95c48a5fab46c255ea4",
    "patch": true
  },
  {
    "name": "employment_assignment_versions_closure_guard",
    "source": "0192_hrm_positions_headcount_plan.sql",
    "sha256": "cda06c9c8b7baaa066743b407281cb405f3c2ca170fc5b9216bddbe1aefe7a5d",
    "newSha256": "ccf6e532f507028a49487406abcd9372e252ea98a6a6bebdeff0ecce06c11f8f",
    "patch": true
  },
  {
    "name": "employment_changes_immutable_guard",
    "source": "0184_hrm_employment_foundation.sql",
    "sha256": "a17b2cffcf48279742709a555ada081e89b25960ed8b63258d422f7e107fd326",
    "newSha256": "c0ab0963e6527424c2a5bdcf0200cd6fa53aec86dc1b4b9624be7d54a160b0dc",
    "patch": true
  },
  {
    "name": "enforce_deleted_role_assignment",
    "source": "0096_active_user_role_serialization.sql",
    "sha256": "efac357dca70ce6700f74745cefae19943cb2175411d02b63b1581f7c9004a58",
    "newSha256": "c19c4d528f0385284be86a5551b4bcd1b5b38551d5ba07a23f77305df033d3dd",
    "patch": true
  },
  {
    "name": "enforce_payment_instruction_posting_claim",
    "source": "0080_payment_instruction_claim_fence_bundle_guard.sql",
    "sha256": "32cce677b2fa4bfa12016c2680b5843e47c42164e2325fa5dfc265c271c85214",
    "newSha256": "9e575165e56acae28f6ee4c6860bf3d969804145aebab39943a351bd4c6c1b9d",
    "patch": true
  },
  {
    "name": "entitlement_ledger_append_only_guard",
    "source": "0001_baseline.sql",
    "sha256": "a651e3b7e5b0a8d0b4394758cca04de07e73591043922fc16e96b2d8df5d32bf",
    "newSha256": "dfd652399b54d27996e3c349ba223167950cdbd8a7304e2b3c31ca898552914c",
    "patch": true
  },
  {
    "name": "field_ticket_labor_line_immutable_guard",
    "source": "0581_field_ticket_evidence_native_sandbox_lifecycle.sql",
    "sha256": "bb9e07caa0c7f8d7fbae3229816bff3683e3862e95ac35ceeef8fcb61e29be4e",
    "newSha256": "63df9eea369f3b28d3d83cd9634dba76bedba7bb65a1e471f25320fbfbb734d6",
    "patch": true
  },
  {
    "name": "field_ticket_labor_snapshot_retention_guard",
    "source": "0581_field_ticket_evidence_native_sandbox_lifecycle.sql",
    "sha256": "f0e70fe6c87f9e4a6cec129e4619c9099efba45bf23e91279914d7fa57dd5820",
    "newSha256": "a33480432dcb45198c495d4a7c80cc49de61d6cb8188cb43660519845ef76d17",
    "patch": true
  },
  {
    "name": "field_ticket_signature_immutable_guard",
    "source": "0581_field_ticket_evidence_native_sandbox_lifecycle.sql",
    "sha256": "0def0530be74e64bbc995a1b55edade8e64094dadd80d748a0298d42c904b1a2",
    "newSha256": "83be40a487799d8acba62604cc7aff69848407a9a621a7c43007ab366af4d89f",
    "patch": true
  },
  {
    "name": "field_ticket_signature_request_guard",
    "source": "0001_baseline.sql",
    "sha256": "7c1af06e204db4d5bf24c9ed77df5ae37f45724ab8ec20fb0e3a671af4682ea2",
    "newSha256": "28a8ef5f383204287bdfb7af9d8dfa53d6d67edc1c0721d86387237e30f76c2a",
    "patch": true
  },
  {
    "name": "financial_change_guard",
    "source": "0458_mfg_scrap_frozen_snapshot.sql",
    "sha256": "ccb63c80d1213a103a75a36dbe44601dcfbf5714bf16a30448c54a774df4e2a4",
    "newSha256": "d31367c8e253a2a2804ecf971c8726bab2ebbd38f916bff34255f6f8b305cdda",
    "patch": true
  },
  {
    "name": "fulfillment_documents_guard",
    "source": "0421_pick_lists_and_shipments.sql",
    "sha256": "bdd0fdf860992d29a965a51eb6f381ea3647677885168296e1e16f330626c22c",
    "newSha256": "944300da429fd422e03b462d0560f31c13ec0d035bc490c7673fb2c87b7842e1",
    "patch": true
  },
  {
    "name": "fulfillment_lines_guard",
    "source": "0421_pick_lists_and_shipments.sql",
    "sha256": "921d49cbbb5d5792b8c48ec48d522985f53204af07486b56b0a4a86755692b88",
    "newSha256": "a7d34ce55cb1dc13d08a42679a32ab41aa3f47cfc4511bb3f6622110c604d006",
    "patch": true
  },
  {
    "name": "fx_rate_age_policy_history_guard",
    "source": "0547_fx_rate_age_policies.sql",
    "sha256": "64b329661f80ea61825a51f68808849f9c4f68a11a7687a308cb42c8b714d38e",
    "newSha256": "b14cbc28e1a1e44b10569eaaf71ee71b8ffd738e8b7ff4c42800044e4f19bb62",
    "patch": true
  },
  {
    "name": "goods_tax_registration_history_guard",
    "source": "0466_canadian_goods_tax_evidence.sql",
    "sha256": "31c5bbfd2a326b2e7ddff1d68d791d693b8da491f89da8461d5e2426850e7160",
    "newSha256": "6fedb5a2637c1c3ab2003a4f37b51d9762b73fa6ad517664e8ae61be75314687",
    "patch": true
  },
  {
    "name": "goods_tax_snapshot_guard",
    "source": "0466_canadian_goods_tax_evidence.sql",
    "sha256": "0a5691b367a50c8924710f095955dbfcd56170848f169c1bd9eba8272100231d",
    "newSha256": "0fe81bd84f2076e84c097a27702bd94c374e262444fc5835c8bfcd7219318e07",
    "patch": true
  },
  {
    "name": "handling_unit_content_history_guard",
    "source": "0618_warehouse_execution.sql",
    "sha256": "3a14cd3323d79d609e2362fbc6467336dc2ba890c4287e50d8c78358a8f122ba",
    "newSha256": "5012aac6c027f34053eeebb11856a15fc51f86dcb67eaaf10cd0f1c85355ab1e",
    "patch": true
  },
  {
    "name": "handling_unit_lifecycle_guard",
    "source": "0618_warehouse_execution.sql",
    "sha256": "c0854a2856e7344ce4598e4b8b389133e5e896c9e7a51319d2f88a0ea350aac9",
    "newSha256": "40dda5cb006fce4a6f8d80483a0b8a54a3768e838af403fa6d8aef0db7d809a2",
    "patch": true
  },
  {
    "name": "hrm_absence_no_delete",
    "source": "0194_hrm_leave_attendance.sql",
    "sha256": "65be193a039d31fd79ca4c42b6233b1fa103e5f511183608f6a75298f47880ad",
    "newSha256": "4dfa710661af5cd1da8964833ca0642d678a753fe56d669399368db1d398fa9c",
    "patch": true
  },
  {
    "name": "hrm_allowance_payroll_input_no_delete",
    "source": "0223_hrm_construction_rates.sql",
    "sha256": "31a9289ec08516b2a88f50054ce3684b153e60c6fe705a626096fa2fb6393a2b",
    "newSha256": "575691b4d0cf2f55bb6887c8cf33f2d177ce5f6413489756d1f5b858d3546dc5",
    "patch": true
  },
  {
    "name": "hrm_application_events_immutable",
    "source": "0195_hrm_recruiting.sql",
    "sha256": "05874ac30c38ba137627a87ac70266e84aebe9f9f38c1e854b89c41f9667c4c3",
    "newSha256": "d2c14ce1bff8ad9ee2a65a6704c0ad6c5eb8232a60cda187bae9d4b3ad9a6b97",
    "patch": true
  },
  {
    "name": "hrm_benefit_award_event_no_delete",
    "source": "0469_benefit_programs.sql",
    "sha256": "be913574f384be090e2d75fb46f043f99abf5660e650c73ed626ec7f3a53f327",
    "newSha256": "8b7aeef6376ee219518168000059b435deb3281ead8e8b1b11f20e969a817a40",
    "patch": true
  },
  {
    "name": "hrm_benefit_award_no_delete",
    "source": "0469_benefit_programs.sql",
    "sha256": "d32922feb558e8a5452cdaf43ffbb05e39ce7e887d2c27105eb37709691a4e71",
    "newSha256": "5810264f049b00298632357c1834561af76a24d05f7c40b4baef26da1f169384",
    "patch": true
  },
  {
    "name": "hrm_benefit_enrollment_no_delete",
    "source": "0197_hrm_benefits.sql",
    "sha256": "57939f2e31642c4b33f8a9f418c659b0f6827b45ac167d500c5dbbbb562e267f",
    "newSha256": "898504f2380025f85a19e72d13690795ad5ef2fb47c02628de389d7b1598c053",
    "patch": true
  },
  {
    "name": "hrm_benefit_event_no_delete",
    "source": "0197_hrm_benefits.sql",
    "sha256": "359451ace3bfc83ade04de9502ef1499e218445c472157faa122820231a5b3a4",
    "newSha256": "df7f94b59fb24b2714d4549cae807fd3e4ceb8c9ecbe3177422b86c3682ba024",
    "patch": true
  },
  {
    "name": "hrm_benefit_payroll_input_no_delete",
    "source": "0197_hrm_benefits.sql",
    "sha256": "9c4744db4c2637bdf6a33462a9fbf7543a41a5f50aae850ebbf466780fc66d83",
    "newSha256": "a5db92e0ab94edaed339b4990fe5aa0e5cc7094603e0d61df843da6b7624e547",
    "patch": true
  },
  {
    "name": "hrm_benefit_program_no_delete",
    "source": "0469_benefit_programs.sql",
    "sha256": "93d87cfe89f4cd36549689aecc51ee34951d3774f8579a045a54fbd4219cec10",
    "newSha256": "9e46174eeceb6a3b153fcc4a30cb928d9ebea95972953909947e6bd9e5a013b2",
    "patch": true
  },
  {
    "name": "hrm_calibration_event_no_delete",
    "source": "0228_hrm_continuous_performance.sql",
    "sha256": "70c581955a4d89106450031e8806ca48821505e81da35a68126302f36a717ca3",
    "newSha256": "a2ec6cee29ac5151871c4209b95ef3f3d11f3862e97d354e8be535c06d0debd7",
    "patch": true
  },
  {
    "name": "hrm_checklist_publication_guard",
    "source": "0479_hrm_checklist_designer.sql",
    "sha256": "8531ee03d30256a3fdfdb4389455f3631c07ce7a9dd07f4ea28404b442cddc43",
    "newSha256": "8c44f917a1530190e0d7b7efa33f3dbc896953590efe197762cd40b4651f4ac8",
    "patch": true
  },
  {
    "name": "hrm_checklist_version_immutable",
    "source": "0479_hrm_checklist_designer.sql",
    "sha256": "91c09ba2e21531b1a6fa1f37826c75cc650fd9eaf8f1063717d4f8401bdb732c",
    "newSha256": "ed13933eb3d11c55eebbfbb9398a11472f7ad948a285c6a26ef6236c4ef7395f",
    "patch": true
  },
  {
    "name": "hrm_compensation_history_guard",
    "source": "0221_hrm_compensation_architecture.sql",
    "sha256": "9b0f5dee5274f7484fc9b2ecd7ad8b4ff7875ed4ace8a5146022dc39880cd08e",
    "newSha256": "63cd9e6c47db7a2d8a6af794478f6787ed0a83c69ade85797c975cecbd8d0354",
    "patch": true
  },
  {
    "name": "hrm_compensation_plans_guard",
    "source": "0222_hrm_headcount_plans_transparency.sql",
    "sha256": "4d08a142a547379f83f4b749e6de1868021ee66f56981dcd118852d3cdff6702",
    "newSha256": "3f8522705d542f9b28188734d11353d6d989e1177a8f1997f1a07e7cb6e6b468",
    "patch": true
  },
  {
    "name": "hrm_compliance_findings_no_delete",
    "source": "0224_hrm_construction_certified.sql",
    "sha256": "05f8db69c109a938546bb666fc1c5e0cb7e1903d924e92b1001ed02e85993c89",
    "newSha256": "4dc32dd4379c9f03f7c93254fac73a91a40e32fae109c72e31a1d007dea503e7",
    "patch": true
  },
  {
    "name": "hrm_documents_history_guard",
    "source": "0230_hrm_documents_surveys.sql",
    "sha256": "4d7d34dac805d7caee96a4e1cc58f0321cafd230a981472be0545f8a3251bc14",
    "newSha256": "28a5dfc702d46939120d9225fc966d40e419dee1e7c1999654cdd41ac5444a6a",
    "patch": true
  },
  {
    "name": "hrm_employment_change_request_no_delete",
    "source": "0188_hrm_change_request_wipe_allowance.sql",
    "sha256": "e32cba5755e74459c7bc1ccdda476c7f6c9b2e3fda5583e3047cbf99935814c8",
    "newSha256": "979e5d88b23a1017fb86676a898b1e116dc4c1a810edf159ded6ddd6c5dab6df",
    "patch": true
  },
  {
    "name": "hrm_exit_record_event_no_delete",
    "source": "0281_hrm_exit_record_revision_and_audit.sql",
    "sha256": "0eeaa6db06e4f16d87ae82f5f6f84cb8c4e5f1f944270158292e649d177245f5",
    "newSha256": "aa9f109f1f50248d30ce3c37c9c02453b8f9dd1c307b0f3fdeddd5e82bffc817",
    "patch": true
  },
  {
    "name": "hrm_exit_record_no_delete",
    "source": "0196_hrm_performance_retention.sql",
    "sha256": "0fef2334188a4107d7ff40300467119a1af136037cb18929c28c96006144230f",
    "newSha256": "3895558d475803dcb6351fb5e5a7ea29320b4adb902b637cd92bc83b433579c9",
    "patch": true
  },
  {
    "name": "hrm_feedback_no_delete",
    "source": "0228_hrm_continuous_performance.sql",
    "sha256": "30389829fbfe8f844eaf28926e5afc975dc25fe86d94e9c917dee2b601c17776",
    "newSha256": "58ad0c39786c90e926766ca399c6fab116da445cdad4da79cc4f3dbce3257f0d",
    "patch": true
  },
  {
    "name": "hrm_goal_update_no_delete",
    "source": "0196_hrm_performance_retention.sql",
    "sha256": "69fdba4a4c3f4063d73ff2c3a72f095514eec4c56b2457b8e773a682227397f7",
    "newSha256": "8f022cea76f3bff5552aeeaa9474ad5acfc0e1179383df3f6cc0f8565a479ab7",
    "patch": true
  },
  {
    "name": "hrm_leave_request_no_delete",
    "source": "0194_hrm_leave_attendance.sql",
    "sha256": "6cb138fc8a67c74d33a343f7db52661eec57d1574c7adcb89ff015432ea1a00d",
    "newSha256": "74717c499fee9a6e1f48e2eca075cfad18ad12da87643fa3b251e9e0f38ed14a",
    "patch": true
  },
  {
    "name": "hrm_payroll_input_no_delete",
    "source": "0194_hrm_leave_attendance.sql",
    "sha256": "8e8b3b1f8a73d07f328b29e523aa9e4264a6a8a8a1d0979d84280b49c378a22d",
    "newSha256": "3824ddaddadf15c555cb0b19ef413694ad55f9bdb16a6e14b7d38c28d84587d6",
    "patch": true
  },
  {
    "name": "hrm_pipeline_template_no_delete",
    "source": "0195_hrm_recruiting.sql",
    "sha256": "c729f72b3ca91c209954f075ecbfbeace207a7ab2e5a8c3d8ed4df573af2e235",
    "newSha256": "7857864905d2b9a15c1698384cd8c50ae6066b325a84f138175bfe1cf315ab48",
    "patch": true
  },
  {
    "name": "hrm_process_steps_history_guard",
    "source": "0193_hrm_employment_processes.sql",
    "sha256": "51f788d434d64e3cb71ee90e5db9965269075cdbe76d8c47aa29bdd375dfa6ec",
    "newSha256": "cbaaec0dfcca4adf4ae5d4114ca2f7290c6deb063b342cd3e1b076164ebf0e5f",
    "patch": true
  },
  {
    "name": "hrm_process_template_no_delete",
    "source": "0193_hrm_employment_processes.sql",
    "sha256": "7bc8b31a3bf2609f09a81effc983a09223837b45bd973d029c57f9a7177da7f1",
    "newSha256": "ab1672961357916af998d83b9989aa0e8734ccf52e8e2554fba48fa7be9aa14d",
    "patch": true
  },
  {
    "name": "hrm_processes_history_guard",
    "source": "0193_hrm_employment_processes.sql",
    "sha256": "64871daa1c6d5a2021eb27643f0eefb10ce4eda985691dcb863b958e2b5c733c",
    "newSha256": "79dd051b031cc6cfa5cb36ed9b9b5b7e8314b4177373cc5cd465d427e98cb50d",
    "patch": true
  },
  {
    "name": "hrm_qualification_events_no_delete",
    "source": "0225_hrm_qualifications_dispatch.sql",
    "sha256": "287f79cff23ab06711c5cfa8a9e8d39af7563417788dccc3b03d0eadf8626fd3",
    "newSha256": "209482c3cafcc73094e7a51a528e6d7a5710fa6281491f8b5b12e5f766d3e91a",
    "patch": true
  },
  {
    "name": "hrm_recruiting_depth_append_only",
    "source": "0229_hrm_recruiting_depth.sql",
    "sha256": "81fb84408735c17ddb159f15929290aac9e5c5414956c64bfbadef890a8469c7",
    "newSha256": "9098c4f6d31ef1f36e155026c0e283626f44dc666c1c3c0ca2cebc39025b4858",
    "patch": true
  },
  {
    "name": "hrm_recruiting_history_guard",
    "source": "0195_hrm_recruiting.sql",
    "sha256": "20772f6c42f53f37aec414d28c1b1504ba8ce4f97716e352fa01f12d407bbe51",
    "newSha256": "f0ec510aba198e45f488f2c15dcfdeb6a86825c2c47676d782ce92b04975311d",
    "patch": true
  },
  {
    "name": "hrm_review_event_no_delete",
    "source": "0196_hrm_performance_retention.sql",
    "sha256": "ee985ecdb79e5efcdd3c27701e69c8af018a845745234efa02df956157cf4cf0",
    "newSha256": "e680cffa04a450aa4597df712e4c86c4af3a18bd0e98bb2586629449380a6ef3",
    "patch": true
  },
  {
    "name": "hrm_review_no_delete",
    "source": "0196_hrm_performance_retention.sql",
    "sha256": "6264ad41a80fb7947c1aa69a6ca297c8a00be9256a337b0693c66cdb2556e7bb",
    "newSha256": "1ce32ed013636689608f888a748ea3cfca747386c3fd05875f0484942f6c22fc",
    "patch": true
  },
  {
    "name": "hrm_review_template_no_delete",
    "source": "0196_hrm_performance_retention.sql",
    "sha256": "0e055a772bc530f53f2880c0c797fa85fd7231ffc0499dcc5595e31b8df777b5",
    "newSha256": "d2ac564e904a84d1cbfb8edc8a41858626061bbdb33418592f9c4001bf7a2ba8",
    "patch": true
  },
  {
    "name": "hrm_scorecard_submitted_immutable",
    "source": "0229_hrm_recruiting_depth.sql",
    "sha256": "c24fcab8e1c21c78f3e14d72ca43ea2cc48b740eccd48d4df0c53032e4fe525b",
    "newSha256": "c8ca655ef48f31c7dbf44d9a9e8a423b3a33054219200f78ea407a1e555fcdb9",
    "patch": true
  },
  {
    "name": "hrm_shift_guard",
    "source": "0552_hrm_shift_attendance.sql",
    "sha256": "d09d3c7edd691bc56b640f1214a04ebaa8d057e80bc148c32052499cf2b558f4",
    "newSha256": "eda7e61078e4fd4373169cacde61600005ae5c91861580c4d5729e8b7e3959ff",
    "patch": true
  },
  {
    "name": "hrm_talent_review_no_delete",
    "source": "0228_hrm_continuous_performance.sql",
    "sha256": "0fb8da368c72f0d2c87bdc44a1a5697440cdc82f5be92d5475e60e81684b54de",
    "newSha256": "0f064fd83cc7a260b89378aab3ce696e8a20459e3a0dfb9ab06bf11ef17cc876",
    "patch": true
  },
  {
    "name": "hrm_training_guard",
    "source": "0553_hrm_training_delivery.sql",
    "sha256": "d8545f590ff4de3fab6b7d3824c568f6b3a9efbbfa085665af8fbe72877aa4cd",
    "newSha256": "7a29b260521ec3f6cc3b99a2171d8cf8e0a4c85901ae3a83ebdf36dcd14a885e",
    "patch": true
  },
  {
    "name": "internal_billing_rules_history_guard",
    "source": "0582_project_delivery_controls.sql",
    "sha256": "9afadd02371ef178f2c7a93c2eb8f0edbcb22b67e08586712635c9e85e2489e9",
    "newSha256": "315273f3d0a00b6e99d1d4520d1803acb54aa61537aab8ebfea48c01b41f5cee",
    "patch": true
  },
  {
    "name": "inv_move_guard",
    "source": "0001_baseline.sql",
    "sha256": "8829d25702c1293ab6b5f8bb869cddd7a846a3a9229d2494560ef56f88a37832",
    "newSha256": "48846fcf44671154f852786dbaa4546a609ebe430946d189eb54a23bbb4c6ab5",
    "patch": true
  },
  {
    "name": "inventory_count_policy_history_guard",
    "source": "0615_inventory_stock_controls.sql",
    "sha256": "186804410f3f600b31f592f758805df995f8b3c7631631654bdc79be882ca0c1",
    "newSha256": "147c25b98af9a3bf6cf69572e493ff1f0b73f8c18d36c54eb7b8f3699c8b0bbb",
    "patch": true
  },
  {
    "name": "inventory_lot_identity_guard",
    "source": "0001_baseline.sql",
    "sha256": "4b24f2f56dccf057e1b182dc698fe8e8f3fab3b609f8e4f4fd4a0e03244f9e79",
    "newSha256": "dfe6840b72217c786a1adbc395cfeff8c5145de889344961b951615695d48839",
    "patch": true
  },
  {
    "name": "inventory_provisional_immutable",
    "source": "0078_sandbox_wipe_guard_authorization.sql",
    "sha256": "c58082d65aa97e7c4adb9a56bc6a09d3a2dbbdc40d0fc2a0442a1f49ecb19286",
    "newSha256": "e5b8f44470441c5c2d3e9d4110ca813ec909443e6423c7170e068184cca1a65b",
    "patch": true
  },
  {
    "name": "inventory_serial_count_history_guard",
    "source": "0616_serial_count_restoration.sql",
    "sha256": "0c59398344eba4235f222dcd7d55c56f9ed99eab8d89b4035afe61f210bcb091",
    "newSha256": "f6ddf2e298fe9fafac158622051e16063791094e6a2b42570b90dc833d1c9228",
    "patch": true
  },
  {
    "name": "inventory_serial_lifecycle_guard",
    "source": "0616_serial_count_restoration.sql",
    "sha256": "ffebe0014068cda1b663b6db56f852968fcfcdca53a4701519a40b6bb28cce82",
    "newSha256": "dbfa848bebb13a143ed711a40365301b6cb5c3d49e3c41777763266a5cf89540",
    "patch": true
  },
  {
    "name": "je_guard",
    "source": "0440_connector_replay_authorization_guard.sql",
    "sha256": "b04c5bd00429a773ddd89092376fd0be32740dcb545515c3848b70edd73e6778",
    "newSha256": "a2ab4792639530e9886f32cb76b77734bb1bc3f55e512c2995ce25a47d0bc853",
    "patch": true
  },
  {
    "name": "jl_guard",
    "source": "0400_ledger_guard_reversal_and_clone_authority.sql",
    "sha256": "1df5f4f1edb4be73b3ae570859412dfda9d4e0fe25a23ee17ed43fc8551cdca1",
    "newSha256": "4adeae78366e442cfdbbdc9c2b19d999eb3fa00382c686ea6482ee37e8d4e4c6",
    "patch": true
  },
  {
    "name": "journal_lines_check_balanced_stmt_del",
    "source": "0381_ledger_statement_balance_checks.sql",
    "sha256": "afbb0489e6027291e8641f932d49f55cecc076dde2e2b9ce522773de385c02af",
    "newSha256": "afbb0489e6027291e8641f932d49f55cecc076dde2e2b9ce522773de385c02af",
    "patch": false
  },
  {
    "name": "journal_lines_check_fx_residual_stmt_del",
    "source": "0457_journal_fx_residual_group_bound.sql",
    "sha256": "ba13b43ff230091b873a75938c1c5dbce82f2438fa12c9d78403a62d51d226f4",
    "newSha256": "ba13b43ff230091b873a75938c1c5dbce82f2438fa12c9d78403a62d51d226f4",
    "patch": false
  },
  {
    "name": "landed_cost_allocation_guard",
    "source": "0001_baseline.sql",
    "sha256": "7318f56176b2c5a34437c0a009ebc34bc66818bb30c9131b95d7b9fbabf321b3",
    "newSha256": "ac034451984f9c956076f7488a5be2aa278522fb49429ea23cf06ff5e074d03d",
    "patch": true
  },
  {
    "name": "landed_cost_voucher_guard",
    "source": "0001_baseline.sql",
    "sha256": "7a9bd1e895107bad4047d24b4653bf090e2fdb427f2daa94d69b96fcacf16ce6",
    "newSha256": "030348a94775ff4e27197991245ca1cb63d586cb116874027effb3b97833c1cb",
    "patch": true
  },
  {
    "name": "landed_cost_voucher_target_guard",
    "source": "0001_baseline.sql",
    "sha256": "e3835e46d31a270fb106770156fc41ce484fc4bc209e9cf8aa8acc8495ee00ec",
    "newSha256": "01b7005a5cb772deb0302368945eab9cba4865e787e5863a28b5fcc673b12828",
    "patch": true
  },
  {
    "name": "lease_agreement_revision_guard",
    "source": "0202_lease_lifecycle.sql",
    "sha256": "caa37ca9044805c24e4ce748ca32f9059443073606ad4b9c94cd4f048c72ade4",
    "newSha256": "2982b4b6ba82c44a0bd5d020d3e2a5f45dcf2958d5334512e5e4356fca4210be",
    "patch": true
  },
  {
    "name": "lease_schedule_history_guard",
    "source": "0202_lease_lifecycle.sql",
    "sha256": "30d1141683f1e822b46e6c7e64a734234572a56345e699a4543f991050e28427",
    "newSha256": "100716d7f7ec0b3343e3fea8ee2c0b83a060783207991e5b30a9d0081361c58e",
    "patch": true
  },
  {
    "name": "net_investment_configuration_guard",
    "source": "0465_net_investment_oci.sql",
    "sha256": "cd5277e751a98426b11dc7af264ac76cb374645b0779008187a530cd31fc4955",
    "newSha256": "affe81c2ffcdd5ada496b24d196f30b9f774e73345d11a938837929539cff46d",
    "patch": true
  },
  {
    "name": "net_investment_evidence_guard",
    "source": "0465_net_investment_oci.sql",
    "sha256": "7c29f525adadb2a1e4135a2255df6c3df0740d26fb51ac3ad5c6c2de9b059610",
    "newSha256": "21a55d2377f5c1c4cb79e0721b33ad9c0d60f1a077e491bf462ec85866d6573c",
    "patch": true
  },
  {
    "name": "nonprofit_frameworks_guard",
    "source": "0434_nonprofit_frameworks_and_releases.sql",
    "sha256": "7c3217b4eb202242a3827f5262e1512e703ec34e276d10ec8e8d44eb48892a96",
    "newSha256": "a5aa0ab60f87473d1af9fb43a96567dfda2449160a3e24909c219c8e31a38120",
    "patch": true
  },
  {
    "name": "openbooks_bank_statement_line_guard",
    "source": "0335_bank_statement_line_possible_duplicate.sql",
    "sha256": "a9f21e836b32ccb22bfd602fc1cf36c964ce0d5ea79556b121ed4a017d986dd4",
    "newSha256": "f4cd4e43879c5950d76caf0c87c0876acb6d15ef7b5c76231eba30b80cbabaed",
    "patch": true
  },
  {
    "name": "openbooks_gl_activity_entry",
    "source": "0338_posting_guards_and_summary_heals.sql",
    "sha256": "a2794dd143d8954250db4f50874e72696328ac321a4b8d52e4854c060aef1823",
    "newSha256": "26121381f7ace27324ac0dd861d82eb81ac28524ae046bc8f627109aee97189b",
    "patch": true
  },
  {
    "name": "openbooks_gl_activity_line",
    "source": "0078_sandbox_wipe_guard_authorization.sql",
    "sha256": "7bc16460ee32f02254e9ce5b11a41ca94a60242923b54041524d5768fe4d1f21",
    "newSha256": "777490764041ed8ec587b2068394957ef48be8596307a95b0f61d9cde83fad5c",
    "patch": true
  },
  {
    "name": "openbooks_guard_ap_capture_evidence",
    "source": "0001_baseline.sql",
    "sha256": "02b4280663902733d88f28118a3e91f44162a4dffd6fc44e7b51562b8a774c45",
    "newSha256": "db53ecd91cad0c5f3e4c4b9a6a09544db85cebacb91c7b7b422cb2e244fa9591",
    "patch": true
  },
  {
    "name": "openbooks_guard_ap_capture_source_blob",
    "source": "0001_baseline.sql",
    "sha256": "0d9ad41e97992373fca6b55cf3ba9e69f8f1717093ef7772d194412bd8985a89",
    "newSha256": "cc8a8131769000981391399a2601667ca2268afeb7f9386bc863ad4f589cf690",
    "patch": true
  },
  {
    "name": "openbooks_guard_ap_capture_source_file",
    "source": "0001_baseline.sql",
    "sha256": "c3126d46a7cdf94920e6074ccd02f4b3886abc1366faaa0f2e904a3e5ccc4b8e",
    "newSha256": "f11e875cd30ea220309582fe531b50685fb5dfe2d7f308f78c47791726ec2dbc",
    "patch": true
  },
  {
    "name": "openbooks_guard_ap_capture_source_version",
    "source": "0001_baseline.sql",
    "sha256": "05a9054652759f235de3bbf7ac00706af82b85517339bdd490c8af9fe246f2a9",
    "newSha256": "f49975ac3f58b01819de3fa995ad60ac02215a8a5b5d9945d9654379f98e6574",
    "patch": true
  },
  {
    "name": "openbooks_guard_budget_line",
    "source": "0272_budget_pnl_calendar_scope.sql",
    "sha256": "729ac10c1170d49683e3b04034702eae78c29c53a6423ccc887f88fc45cd937a",
    "newSha256": "2781a16dca1c9e08ce87e4640343a673baf8fd37dc81d8d26d5f07cf5bb99994",
    "patch": true
  },
  {
    "name": "openbooks_guard_budget_scenario",
    "source": "0272_budget_pnl_calendar_scope.sql",
    "sha256": "a057cfa923a80b0b9895ca8b2e8495a91220f317f13325ec6103e5978e81050f",
    "newSha256": "aec8fa32f4d454de8223045d4ad73fbe5b6cbb5ebb088637a11a72fb45211dc3",
    "patch": true
  },
  {
    "name": "openbooks_guard_depreciation_evidence",
    "source": "0078_sandbox_wipe_guard_authorization.sql",
    "sha256": "50663d9463c1c0e8e4aa5d38281444c3b54e089cd46b6453a6e7a5f83c050153",
    "newSha256": "6190f0e93e8878123908f1f567892d5f0ed5782a7aaa9faebf30d1f647c16d9e",
    "patch": true
  },
  {
    "name": "openbooks_guard_finished_ap_capture_run",
    "source": "0001_baseline.sql",
    "sha256": "27bf355201b803a886e0ebadb94abc7a9bb505557ff4ac0d5c2639f215e8d1fa",
    "newSha256": "db3f8446ad785d1b92e9e7fce09f58522d4180d9c340b8cb6d27fa75aa17d45e",
    "patch": true
  },
  {
    "name": "openbooks_guard_pay_run_bank_file",
    "source": "0001_baseline.sql",
    "sha256": "e59a1428945231c23443cfc590b8be291866b01d41c5a8b49335f07a0a64ae69",
    "newSha256": "f6cfcc17a384d7c68fba8ece42d685bd96ce40b8eeeaea5e0212d2a6201e5d3f",
    "patch": true
  },
  {
    "name": "openbooks_guard_payroll_bank_file_blob",
    "source": "0001_baseline.sql",
    "sha256": "b778791dd21d24f58f69b19195f0f19e0dc1ed9de3530c44977bfe1030271651",
    "newSha256": "cbab19c98cb81d37b12fdf0f6ee7f9bd4f059cfd663559d0d9d12574d20c36f0",
    "patch": true
  },
  {
    "name": "openbooks_guard_payroll_bank_file_file",
    "source": "0001_baseline.sql",
    "sha256": "044243daf58bf3a8c6633eed4ea3bc0c003c877a500c7cb5480b650ac70c98c2",
    "newSha256": "8b1e26e04aebb8e550a40441660b82fdde94967d2f96ccd991aa6722b3387e4e",
    "patch": true
  },
  {
    "name": "openbooks_guard_payroll_bank_file_version",
    "source": "0001_baseline.sql",
    "sha256": "f4063021c74e4031bb4fa141ab7c635b86163d62267b7aed958e20a20b76a96a",
    "newSha256": "4c9747e8c4e63f4f5b34c7df406aa58ce9f5fdcec7319bfbc6424f060f1304d2",
    "patch": true
  },
  {
    "name": "openbooks_party_payment_stats",
    "source": "0078_sandbox_wipe_guard_authorization.sql",
    "sha256": "229c150014ee8ee417baf95f86c7599a5060b8294cd0553ad2943c60dbaaa0dc",
    "newSha256": "d1f84260a2e8e8cf6c324759fbeef57f032e481e04b07fdd4daa4fc91fe34247",
    "patch": true
  },
  {
    "name": "openbooks_reconciliation_match_guard",
    "source": "0623_reconciliation_match_clone_authority.sql",
    "sha256": "c821ef41d0f81a9b77e2c4ac099dfb6a7de46ff953009aa1987a973d99bb857e",
    "newSha256": "febb0a2f859f4c8a6aa95e2c3d8abe66bcd850babeca7038c2c8155369da8966",
    "patch": true
  },
  {
    "name": "order_line_cancellations_append_only_guard",
    "source": "0422_order_line_cancellations.sql",
    "sha256": "87a378bf9544c3059187a10a05b0c585288528a48c131b9d0ddc1823b24f1c57",
    "newSha256": "7a782502a62a99ca8caf6ca702b4560a72119c6bf02c4d173cd3509b9b1b8695",
    "patch": true
  },
  {
    "name": "org_business_calendars_history_guard",
    "source": "0563_business_calendars.sql",
    "sha256": "ec7ee836eb5eb5ad3ee5ee521643637dbb515d887e072583202fcca4eed31134",
    "newSha256": "2bd22a5308a1f5da9c7e563fe93a0094f9d503be88cc7aa0b7548e31338ca42f",
    "patch": true
  },
  {
    "name": "pay_component_earning_classifications_prevent_orphan_delete",
    "source": "0551_payroll_compensation_packages.sql",
    "sha256": "4b1791a21d7759e8b104b6f44aac88523faafebfb6d82182346ced33f39a58f6",
    "newSha256": "8137f80212bd6d6c0987c647c8e3d3c112d2ef2755bf06ab2d73185f75058f9c",
    "patch": true
  },
  {
    "name": "pay_component_history_guard",
    "source": "0092_pay_component_snapshot_flags.sql",
    "sha256": "f192d88367ea3453c46e0644710916e50cd89b4f06d18bb68d5edaa0e49aec05",
    "newSha256": "f0ead9e55daefcb55057d74227cc9410fcc9c96704a8f318c10108f6d213d8c8",
    "patch": true
  },
  {
    "name": "payment_event_immutable",
    "source": "0001_baseline.sql",
    "sha256": "2ffa9522f5e2aea0f0d05d49d371b4f25038fdd8b7efdf0532590f7d27df1170",
    "newSha256": "703820e2c3a1013d117df32c43ec288bf2feb20491c912e02d7017dba2d2a4a9",
    "patch": true
  },
  {
    "name": "payment_run_item_guard",
    "source": "0001_baseline.sql",
    "sha256": "e3e5ab9e8a40e61b6296d6e58175d010e2eb667178ec73a051dc4c82a95a52de",
    "newSha256": "8fe0c6aff0cfc9528429baa03f46780e626cafe1efd8ed134bedbef0bed43a5f",
    "patch": true
  },
  {
    "name": "payroll_annual_period_bounds_guard",
    "source": "0560_payroll_period_openings.sql",
    "sha256": "254d3e9199710c1fbad5d87ef3a079b3e7873cbeab04cbf187bdc8d8c871ba6b",
    "newSha256": "b0934f0f9930ec7800cc8286bf0c0469528f9b5c4d400c60603688ba6e8b73fd",
    "patch": true
  },
  {
    "name": "payroll_compensation_calculation_guard",
    "source": "0551_payroll_compensation_packages.sql",
    "sha256": "b60900bb0f3449fa05059f1327ff047a7aa50a0ceacbf3107d7faadc5d1fa030",
    "newSha256": "9bf4bdfb630110ea8731d08aae67eb08bdc5cd5e5c302b819991d9d88478009b",
    "patch": true
  },
  {
    "name": "payroll_compensation_configuration_guard",
    "source": "0613_compensation_configured_flow_approval.sql",
    "sha256": "c6149107f87b0958e81b959e3cfc4a27df54dd89d55b5282be7f10afcdaffa02",
    "newSha256": "879e9da92cf7a615921b03e541e68fc0a30de196628ed9c21d224c232de06d79",
    "patch": true
  },
  {
    "name": "payroll_employee_employer_assignment_guard",
    "source": "0568_payroll_employee_employer_assignments.sql",
    "sha256": "7c17a9a116a5c08e97e7baee28a1b17f4f2275deb3747ec627117a12e921ad3a",
    "newSha256": "7918f607fec3e0c80ff92d2a41e23e2775cb2de98cef017993ad2a7a5b6681ca",
    "patch": true
  },
  {
    "name": "payroll_holiday_allocation_audit",
    "source": "0606_payroll_holiday_settlement_allocations.sql",
    "sha256": "f4fb468d09a84edd8c34464b5bccc060bda863fa58f475b2919c65eb48e98215",
    "newSha256": "61c473adadc109c7f0d90259fa62b1258663fe3627f175681763bfe74a03a4a5",
    "patch": true
  },
  {
    "name": "payroll_holiday_allocation_guard",
    "source": "0607_payroll_holiday_historical_clone.sql",
    "sha256": "6f894f19e18a5f455574b4cbd4c07729209d6788e121e2b93832dbe9c7efcc65",
    "newSha256": "1868461bf68220c4969db8657957f7eaa7d5d98464a5060afc10143a204eed9f",
    "patch": true
  },
  {
    "name": "payroll_holiday_obligation_guard",
    "source": "0610_financial_change_configured_self_approval.sql",
    "sha256": "fdc015a4221b113894f8581437818bd58ce09ecc12689c920129f0dfc4c55e75",
    "newSha256": "91f56340922be70370d52d89c669a99fb6458134c6974ee83d63cf715ad4e12c",
    "patch": true
  },
  {
    "name": "payroll_period_opening_guard",
    "source": "0560_payroll_period_openings.sql",
    "sha256": "78cc3909965364530ec42e81d7ec2eb0d89e5a542d51ba06b42f7f17f5a1b6a3",
    "newSha256": "c03aba9b5e0a215518f7cd976d5527399e5bdf14bd618142c58b31c352d4e66d",
    "patch": true
  },
  {
    "name": "payroll_program_period_bounds_guard",
    "source": "0560_payroll_period_openings.sql",
    "sha256": "0cfe76cc62209d74ab14a2cdaf22a217c4a6bdd556198cca2f08b63fcc33bdf5",
    "newSha256": "b64f55188a39928326eacf09f7a20ad9ec17ce0b9e341ae6fe9e2a8337089c3d",
    "patch": true
  },
  {
    "name": "payroll_service_configuration_audit",
    "source": "0477_payroll_credited_service.sql",
    "sha256": "08224f95861dda28c8948555fe08e5e1365f5eff3f234f04d01a70f57e29aa4b",
    "newSha256": "2bb2d1b15b48142adeb8a29e3711dad3e0c00165998179f355cb017710ebd266",
    "patch": true
  },
  {
    "name": "payroll_service_configuration_guard",
    "source": "0609_payroll_service_configuration_historical_clone.sql",
    "sha256": "b55136dbabdee59680b62baad4cc936b92124d1af4fd9c24c424c1007c3f5da9",
    "newSha256": "6ac030125b6caa98e1e8a293704160c57f95aeac53488eb31386c78cf45686ab",
    "patch": true
  },
  {
    "name": "payroll_work_location_allocation_audit",
    "source": "0362_payroll_work_location_allocations.sql",
    "sha256": "e7f5f1f87fd688f0402e4ee61e24698468e5adba81d5c17aca960ae939f90ef6",
    "newSha256": "e28337e0ef26347c422accb607a0e14549c6332a189284e668faca1b964aa45f",
    "patch": true
  },
  {
    "name": "payroll_work_location_allocation_lock_committed",
    "source": "0362_payroll_work_location_allocations.sql",
    "sha256": "30ee18d762a6c21ffcf47cb2d5844b81fc3fb0303d6f0a646892c83f0060b57f",
    "newSha256": "06a75b03f20e6de17d1d944ccea9d7bc58574cda9a1b84feef0a36525462da79",
    "patch": true
  },
  {
    "name": "pick_execution_history_guard",
    "source": "0618_warehouse_execution.sql",
    "sha256": "5c13cb9268df8f036f463e7e3d2b0ac78852ebef32ef31277ba8bad87303445d",
    "newSha256": "6675b41773ba7d0e780fc4af92adbed3d0712a8a979151285f50e700bafc1b48",
    "patch": true
  },
  {
    "name": "position_changes_immutable_guard",
    "source": "0192_hrm_positions_headcount_plan.sql",
    "sha256": "5508feab8972dcf631700c00995c0429437af02b097f4176dc467862fa336351",
    "newSha256": "df87953844fc19d4951b81f9fb59eff39f7abd4cef092e981878611f9b5dd42d",
    "patch": true
  },
  {
    "name": "position_versions_closure_guard",
    "source": "0192_hrm_positions_headcount_plan.sql",
    "sha256": "c1a40597f6bcd331094b63b9d3ee6663fac5b92addb3d10cdcd4c3559a0f2be5",
    "newSha256": "8e76bc2f6ff00b7977134f9f829de4ecbb855bad72294a25ceec69d14f643550",
    "patch": true
  },
  {
    "name": "preserve_historical_compensation_cycle",
    "source": "0559_hrm_compensation_source_cycles.sql",
    "sha256": "1d921962796f5e6c85117ba90c3464c00af30fc4274e69c2c423faaac89d87ee",
    "newSha256": "d4eccf072e15d665398d2e78899dd28760bd0cf710aadedd970985d702b5ee98",
    "patch": true
  },
  {
    "name": "primary_book_history_guard",
    "source": "0102_primary_book_history_guard.sql",
    "sha256": "73c4d9e7675ab7a99b0a29fb60a38302f7bba33ff9cea5431d8c3a714147fd3b",
    "newSha256": "bac7038f8e1a8a71ba77fc0353678ffd3ff8f3ceaad140f4b2e1bbba4724582f",
    "patch": true
  },
  {
    "name": "project_delivery_evidence_guard",
    "source": "0582_project_delivery_controls.sql",
    "sha256": "0a9b924933d0c3a59d18888ddab6f2abc6757ad1a4461029863df46f8ba79bf7",
    "newSha256": "90f6b8629e4bf0a2fd2fa2d122a2d8328f4f8d698a5e6ea393a7263163071703",
    "patch": true
  },
  {
    "name": "project_financial_adjustment_guard",
    "source": "0001_baseline.sql",
    "sha256": "9698849341756d30106cfadd859cbf7cf394070b755ff59afa82cf0bab6a3d11",
    "newSha256": "ba265cb9c6f0b3d2fadf9acee953bc302fc4219126bbe07115bf3aa413e5d540",
    "patch": true
  },
  {
    "name": "project_financial_profile_version_guard",
    "source": "0099_project_profile_sandbox_teardown.sql",
    "sha256": "f3b7fb24767592896f73613ec51650534355e1cc3301ad751898c187a14e6319",
    "newSha256": "738be67b3d035dabd7af11b684ca513b6c42e1e7af9811a1bd73f644bbac619b",
    "patch": true
  },
  {
    "name": "project_overhead_adjustment_guard",
    "source": "0001_baseline.sql",
    "sha256": "c096dc75ae3d7e964c6f11afc4d8560c3f0d4ebe7d6997a7e510a89a6534516e",
    "newSha256": "1754d5277624f2248651c0cc57e98c1ac33e8f860cb2211496c82b12dd63364c",
    "patch": true
  },
  {
    "name": "property_financial_evidence_guard",
    "source": "0001_baseline.sql",
    "sha256": "cf412831c91d63939865a38c9c0da773bf3d2cc7a6470e5830d226cfba1fd5fb",
    "newSha256": "e64cfe122d93789c0a64e2410b9e6eaa213f5ee501dc81cdee65a0b943a76ba1",
    "patch": true
  },
  {
    "name": "protect_application_idempotency_key",
    "source": "0402_rls_bypass_trigger_bodies.sql",
    "sha256": "51a6d8252d54ee5b75a3d6ead4faf5e3b231a5d4bb3216abb06536d2d4830e51",
    "newSha256": "1972cf0709d1c70ba282f05046deff4e8deb311235964166c0e925526e93d0cc",
    "patch": true
  },
  {
    "name": "protect_country_tax_pack_installation",
    "source": "0078_sandbox_wipe_guard_authorization.sql",
    "sha256": "5b6eea6d4d8590303769f521df79b4bf86ff5eb3d34925434687df1bd7f0e211",
    "newSha256": "a77c1c221ecd79d284d26e35419ea97d44aedba30f9f4feed10c8423b5120069",
    "patch": true
  },
  {
    "name": "protect_org_base_price_level",
    "source": "0245_price_level_guard_sandbox_wipe.sql",
    "sha256": "c763d05cbf9084021ecf5b60a93fd8c2132b0e28085360def2136bad3b290760",
    "newSha256": "3acf699fc53c9df67a5240e56378a8470210221b6008707c8d28e69bd98de7b1",
    "patch": true
  },
  {
    "name": "protect_pricing_customer_role",
    "source": "0247_customer_role_guard_sandbox_wipe.sql",
    "sha256": "00de04b3113fbe9084a84182d0cac497644e423dd82369b36e8c97e9ed501bcd",
    "newSha256": "3d82d2ff31a128c0f932c963ff29a02209692966c48267fea22f55af2876622d",
    "patch": true
  },
  {
    "name": "protect_tax_provision_history",
    "source": "0001_baseline.sql",
    "sha256": "a394c63726b88d6310039e8807885c89c3fb5ece7f165379851d27ec8b3f898a",
    "newSha256": "d97e46fcd7752fa5eec576792ec10443bf4fe1d3cd5f05b6a77024b54d59434d",
    "patch": true
  },
  {
    "name": "protect_temporary_difference_history",
    "source": "0001_baseline.sql",
    "sha256": "6c0ad6b3078c083614914401295a7fa33d359fc8ef85aadeab75375b2f289024",
    "newSha256": "677df694d5525b671ce6eeb3f8bdd11fca79730a3e7de988693bec3c6f77662f",
    "patch": true
  },
  {
    "name": "provision_identity_guard",
    "source": "0459_provision_obligations.sql",
    "sha256": "7db4b6a987c3470686b45d6f39553d60b7291b92fc3fedafb67e00157aaee4a6",
    "newSha256": "03aad968bc3e6e396b6a16b679fb91a6f77fd2e7fbde21e4b28f4f1954725f99",
    "patch": true
  },
  {
    "name": "rate_adjustment_target_version_guard",
    "source": "0001_baseline.sql",
    "sha256": "8efd5f792575931f78e04d36780115b995e3605dc1b4ea858bf821241a3f221a",
    "newSha256": "8d3662d80c3bbe419040a4b302211223f9e705d11686af3932a044b41528f682",
    "patch": true
  },
  {
    "name": "rate_book_currency_guard",
    "source": "0001_baseline.sql",
    "sha256": "e937e1909628cb2555c0e0c45d57a229b4fdd79ceebb3d07dca946999194426b",
    "newSha256": "8b50942579e305f23f4b0cb174ff4f62735fdff3048f813f8f5595c36ae64487",
    "patch": true
  },
  {
    "name": "rate_version_child_guard",
    "source": "0569_clone_preserves_activated_rate_children.sql",
    "sha256": "58a14ec3f19fe846832ff24d993988803820dd7a9670fa5b9af427378d6d9941",
    "newSha256": "1c6a2c19dce2d753eb1f81a10fb24701677f1df4cdb77d4878921c1a731e1e58",
    "patch": true
  },
  {
    "name": "rate_version_immutable",
    "source": "0001_baseline.sql",
    "sha256": "d486f90af091d60a1dbf20121beeaf3c758d9e8d48209ce9ec67d444485fb5fe",
    "newSha256": "ce293e6767e40d1ec0838aadcb2bfc417f0cc2f165079c8c22e1b9c5cd72eb77",
    "patch": true
  },
  {
    "name": "recognition_revision_history_guard",
    "source": "0203_revenue_contract_modifications.sql",
    "sha256": "5a75a9a2bb5492a9b91f701dc86949f66788c056a26275014ece3ca784cf895a",
    "newSha256": "05a10a1ab732449914565ab6e3bc7e8ce1b8faea1af870964f71f1a052280474",
    "patch": true
  },
  {
    "name": "recurring_occurrence_document_immutable_guard",
    "source": "0078_sandbox_wipe_guard_authorization.sql",
    "sha256": "57c143eb58fc0d72f7a932b05e4bb64f83076624518ef0061f41fb081cb5b2fe",
    "newSha256": "0686abfe2fa5f65a8808baa3035d13aca021ecf3b1f285746c45612352af91e7",
    "patch": true
  },
  {
    "name": "reporting_relationships_closure_guard",
    "source": "0184_hrm_employment_foundation.sql",
    "sha256": "a320a6ce999caa0c5ec29feb3e8bb9d8aaa2960600ee1c787c58a63e56ef60b9",
    "newSha256": "2136f7308beee0af0fe379d9e00f19179fc6ca7e3494eb7168f5d1cbb8b0452c",
    "patch": true
  },
  {
    "name": "saas_metrics_fx_evidence_guard",
    "source": "0455_saas_metrics_normalization_evidence.sql",
    "sha256": "6b962fb7888f3c51240e6d74c2321722822558a5cc1e455b122f3b167ffe55ac",
    "newSha256": "e4bedd42fddfcb67b43e1eb47ed4f012b01993689f6148c6671ee0e7e48061a0",
    "patch": true
  },
  {
    "name": "saas_metrics_normalization_request_guard",
    "source": "0455_saas_metrics_normalization_evidence.sql",
    "sha256": "da0887ef9cd0720fcf33eb0f7afd2895bc05fc8be9672c8c97ae38ac7785c0a4",
    "newSha256": "247efba51dea9e7fefac63082e707b716495d9e7774d93574f821d29a4018948",
    "patch": true
  },
  {
    "name": "sales_evidence_immutable",
    "source": "0571_sales_evidence_native_sandbox_teardown.sql",
    "sha256": "9c3ecf85e3ae9e685d1e16c3e0a9389f9b9f52ff3068f1e7f0c5c0e78b561e2b",
    "newSha256": "4df5bdace9684470f6835ca7d344438409a88c1650235410d5fe3c10f1c0704e",
    "patch": true
  },
  {
    "name": "sales_quota_version_guard",
    "source": "0625_quota_sandbox_wipe_authority.sql",
    "sha256": "7f1557383681d94059259b9285130e6bc143339200271ef2775d7c94a30ba2e2",
    "newSha256": "5b9db55547f9dc528b15a3d4d1515676b0d831f8d3011681b432bacbfb852449",
    "patch": true
  },
  {
    "name": "schedule_boards_guard",
    "source": "0592_schedule_board_resources_and_display_rules.sql",
    "sha256": "4ad2f0c147ccbba07126486726c5daf572ee8a44be69a03f01096c9b297c1896",
    "newSha256": "37b10c7cfccd4dcf35cf120ba556d264d4851d724c81598a21731c949386173e",
    "patch": true
  },
  {
    "name": "schedule_codes_guard",
    "source": "0583_unified_schedule_boards.sql",
    "sha256": "060e5c75fc25379fa181436edfd0a9fe8c9fb6531ad22c087a038ed8b11d0540",
    "newSha256": "1dda2b3e9943c243fa8222c699da8170a6b27e869b509ac0d86859a1a7fe826c",
    "patch": true
  },
  {
    "name": "schedule_distribution_snapshot_guard",
    "source": "0614_schedule_automatic_delivery.sql",
    "sha256": "7f4362628d4949f82086004d861075065784ea5ef4958a728326a0d883045fef",
    "newSha256": "eb0a898ddf396edd67589f4a09e19e2e01f216f878c801fdbd968924ef160293",
    "patch": true
  },
  {
    "name": "schedule_entries_guard",
    "source": "0592_schedule_board_resources_and_display_rules.sql",
    "sha256": "7519afe666e358d487c3f7e5b55d562431507770d1ad35d598b67f462d217122",
    "newSha256": "252d1f24f9f634435b71e1f9fb8fa2d608d0187c2d4d8266d50282d594f4e01a",
    "patch": true
  },
  {
    "name": "schedule_source_records_guard",
    "source": "0595_schedule_source_history.sql",
    "sha256": "b1ebb5aa91fc27f4a3d7c1c2c7a110cdf994f6a8d998e7b8f1ede614f23563f0",
    "newSha256": "842dfbcc6955650ff1f4b57b571ae9f5c88139ed379fc60338d8b9d6fa1282fc",
    "patch": true
  },
  {
    "name": "scheduler_outbox_terminal_audit_append_only_guard",
    "source": "0026_scheduler_outbox_terminal_audit.sql",
    "sha256": "cefffd2645431dffa7f33ad2116b1d280aff8de152f672a861ea263b4fb7c447",
    "newSha256": "e06165f8a6c619f2f5e0330903ff5f452a9ab99f1890fc4e976fa837ac6fed65",
    "patch": true
  },
  {
    "name": "segment_definition_guard",
    "source": "0001_baseline.sql",
    "sha256": "1760c75a0593b206faae064c33b4ba7f6dc0089a8d71d08602dcaaf07e287ed6",
    "newSha256": "2ea0c74c89bf6cd02a84e4a119e0d5a587deed667b19bc58451520a94683f378",
    "patch": true
  },
  {
    "name": "segment_values_clear_default_for_wipe",
    "source": "0433_fund_balancing.sql",
    "sha256": "c75b039abd9a5353a046829ef67337baccb729c87b8147c9f73e348610dc049d",
    "newSha256": "192f2debaca0fbf7b3194a761311508400376928790129973bba01afc13e4ccd",
    "patch": true
  },
  {
    "name": "stored_value_entries_immutable",
    "source": "0495_stored_value.sql",
    "sha256": "8e1d34eaf3b7547657637b9de3e49c092f50a33ad70b78d0ceb1796042a7b89f",
    "newSha256": "d927e8e75615245d5cf99cec4d6eeaea396be4985efc111cbec42b6058584247",
    "patch": true
  },
  {
    "name": "subscription_amendment_immutable_guard",
    "source": "0078_sandbox_wipe_guard_authorization.sql",
    "sha256": "af134f0c0d50b49b5bb24faa56213d63dd5216f33d7a90de5a7ac31e9b06fd12",
    "newSha256": "3c1da0c44f593c4527ced4a54f4f404e4c3282136f9fcfd54eabcdbe61997f80",
    "patch": true
  },
  {
    "name": "subscription_period_invoice_immutable_guard",
    "source": "0078_sandbox_wipe_guard_authorization.sql",
    "sha256": "d34cf2b3c78d544714c5c0fdfaf46245587915e9cabbd6c2a3bc1e506358ff13",
    "newSha256": "23d0de0c0229e73837d6512a1e5101c2c78956de5d64c666746a93f1781cd182",
    "patch": true
  },
  {
    "name": "subscription_plan_version_immutable_guard",
    "source": "0078_sandbox_wipe_guard_authorization.sql",
    "sha256": "534ab687f6b38854fe974e0c04a01eb4f0e4d953fd49fdfe2d42d4dbc59796a9",
    "newSha256": "c8fe1c60cb2aec5b713eaf88b737a5690c25bba90e6825c23a4197ae2127f3e3",
    "patch": true
  },
  {
    "name": "subscription_version_component_immutable_guard",
    "source": "0078_sandbox_wipe_guard_authorization.sql",
    "sha256": "a90030f5c33edf968f8572a5053ebd8746928f7abf71cbed8cff29e2bc8c78f5",
    "newSha256": "02be1977312662234c76201fb184116c3faf3134152b42e2493f50ab37aad750",
    "patch": true
  },
  {
    "name": "subsidiary_tree_guard",
    "source": "0045_subsidiary_tree_guard_serialization.sql",
    "sha256": "63e47197ca9033111c4bc3356c339b226a27e573e2e7ff14ef52b3d06b660c97",
    "newSha256": "0b5767d39aa05642b6838d3e9076bf9b7d4dab898fa672044e80a909d45e43d4",
    "patch": true
  },
  {
    "name": "tax_filing_immutable_guard",
    "source": "0001_baseline.sql",
    "sha256": "82dd24c4dd4cb95ac232674867d3ea11b645c971886e074ac31aa601f6d36b7b",
    "newSha256": "e349880078c43089986ecbb508e2ecf10fb108a6da4a37010e0b86f3d064c9f9",
    "patch": true
  },
  {
    "name": "trg_application_open_balance",
    "source": "0580_clone_preserves_recorded_document_balances.sql",
    "sha256": "17708233fcd3ef11d4d5fd62dcc00d0e7fa436da3f400c3d4bf63b4f2232f2d1",
    "newSha256": "525c5a29d7ab304d49b57903b61cad23b8645f110be919acc7629c9dee3bca5e",
    "patch": true
  },
  {
    "name": "trg_journal_line_open_balance",
    "source": "0580_clone_preserves_recorded_document_balances.sql",
    "sha256": "1309729a7bf15fa24d5747ed526384f459bc999c39896cd86adbf72653086ca8",
    "newSha256": "66b229cd6249b55ea2ce95f59d0269f023557da9e058ec65905b95a9eeadf00b",
    "patch": true
  },
  {
    "name": "usage_prepaid_draws_append_only_guard",
    "source": "0426_usage_rating_plans_prepaid.sql",
    "sha256": "a898f5c4f5715129e767382fb5d6834603c0425423212c265919661f87866fd0",
    "newSha256": "1a225c03a8c7331a2153573dada85fb1ae4650013d58f739cd811e7df0fdc5d3",
    "patch": true
  },
  {
    "name": "usage_rating_bands_draft_only_guard",
    "source": "0426_usage_rating_plans_prepaid.sql",
    "sha256": "63da0f86046762f99a0ce7a4aa25c1f8a657dac7719593b1eb74ba36bce68d6a",
    "newSha256": "b26b1a23b258d50c89ce8d325f22959ceb37372cecffcff9de6d6092db4a38f4",
    "patch": true
  },
  {
    "name": "usage_rating_published_immutable_guard",
    "source": "0426_usage_rating_plans_prepaid.sql",
    "sha256": "2874beeeebfb75bbc3aa458d1ea79a1d74fdccdf3ebf7c8d87ed830fa2b60458",
    "newSha256": "771b81372107771d669c23bd41902a3819aafeb8e4e3ca6324333a45811b8960",
    "patch": true
  },
  {
    "name": "warehouse_execution_history_guard",
    "source": "0618_warehouse_execution.sql",
    "sha256": "a19af2a008d1caa8ed82f77e3cb3c34d899f69dfc3d2efee9861f2f9a37b1dcb",
    "newSha256": "0c5ef4f71e53ad59a12393563c90b21ce24c28de4e34f575efb62c68f82ba096",
    "patch": true
  },
  {
    "name": "warehouse_execution_task_guard",
    "source": "0618_warehouse_execution.sql",
    "sha256": "ca71a4c236c3e082a639a1212720118fd02dbecc45620e651f6eb7ac9df53329",
    "newSha256": "069458124b9d9fac6696ffb2c7bba6efa5df9d8d3ab5cc96d29715723f6e4c62",
    "patch": true
  },
  {
    "name": "prebill_event_append_only_guard",
    "source": "0589_pre_billing_names.sql",
    "sha256": "754932f504ca612f612dce0b6a13fe9a0551b251b1469ee84cfe7998feb590e1",
    "newSha256": "0a43989514038d7da4d58d6b9ed3ec2aee530e3af0f6c6bd75368ad4ed556b2b",
    "patch": true
  },
  {
    "name": "withholding_deductions_guard",
    "source": "0599_contractor_withholding.sql",
    "sha256": "f4cb514dda38b4202a0cf0b8ea6f304d9ff3fcec36e2985db329ce186d76ef58",
    "newSha256": "7fdd60eac96af3fd2b292a96a98a60cb16ca7d6226c49316c9d8bec1f851341a",
    "patch": true
  },
  {
    "name": "withholding_returns_guard",
    "source": "0599_contractor_withholding.sql",
    "sha256": "4d68c8d76b52b2eec915177d535faf4113542d3b163ef5700e3cd19e95f47371",
    "newSha256": "378492d95d6d89fa810080fa5d1a4cd8b1f05693e0f7a565ae1fe781f5cb8814",
    "patch": true
  },
  {
    "name": "worker_employment_versions_closure_guard",
    "source": "0184_hrm_employment_foundation.sql",
    "sha256": "6b77c2d1c0de0455a425ef2201c1703e2a197b67fcfcd19e81a97fbc8829ef83",
    "newSha256": "7154c9c44fe3b809e2c3f1e583fe2ad9d7518e4704618edd4935894974454965",
    "patch": true
  }
] as const;

export const TENANT_RETIREMENT_GUARD_ATTRIBUTES = [
  {
    "name": "account_group_member_scope_guard",
    "config": []
  },
  {
    "name": "aging_bucket_policies_history_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "ai_decisions_refuse_update",
    "config": []
  },
  {
    "name": "allocation_rule_target_guard",
    "config": []
  },
  {
    "name": "application_evidence_guard",
    "config": []
  },
  {
    "name": "assembly_disassembly_immutable",
    "config": []
  },
  {
    "name": "asset_basis_change_guard",
    "config": []
  },
  {
    "name": "asset_event_append_only_guard",
    "config": []
  },
  {
    "name": "asset_transfer_history_guard",
    "config": []
  },
  {
    "name": "asset_transfer_measurement_guard",
    "config": []
  },
  {
    "name": "audit_log_append_only_guard",
    "config": []
  },
  {
    "name": "benefit_catalog_identity_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "benefit_recovery_source_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "benefit_recurring_audit",
    "config": []
  },
  {
    "name": "benefit_recurring_configuration_lock",
    "config": []
  },
  {
    "name": "benefit_recurring_history_guard",
    "config": []
  },
  {
    "name": "benefit_transaction_rule_audit",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "benefit_transaction_rule_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "billing_request_field_ticket_guard",
    "config": []
  },
  {
    "name": "change_set_items_lifecycle_guard",
    "config": []
  },
  {
    "name": "close_append_only_guard",
    "config": []
  },
  {
    "name": "consignment_event_immutable",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "consignment_position_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "contract_cost_amortization_immutable",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "control_loss_history_guard",
    "config": []
  },
  {
    "name": "control_loss_source_guard",
    "config": []
  },
  {
    "name": "data_transfer_evidence_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "depreciation_book_policy_history_guard",
    "config": []
  },
  {
    "name": "depreciation_evidence_attachment_guard",
    "config": []
  },
  {
    "name": "depreciation_non_gl_recognition_guard",
    "config": []
  },
  {
    "name": "document_correction_lineage_guard",
    "config": []
  },
  {
    "name": "document_line_immutability_guard",
    "config": []
  },
  {
    "name": "document_line_tax_component_guard",
    "config": []
  },
  {
    "name": "document_lines_total_line_refresh",
    "config": []
  },
  {
    "name": "document_lines_total_line_tieout",
    "config": []
  },
  {
    "name": "document_supply_evidence_guard",
    "config": []
  },
  {
    "name": "document_tender_lifecycle_guard",
    "config": []
  },
  {
    "name": "drop_ship_allocation_guard",
    "config": []
  },
  {
    "name": "dunning_log_guard",
    "config": []
  },
  {
    "name": "einvoice_documents_immutable",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "employment_assignment_versions_closure_guard",
    "config": []
  },
  {
    "name": "employment_changes_immutable_guard",
    "config": []
  },
  {
    "name": "enforce_deleted_role_assignment",
    "config": []
  },
  {
    "name": "enforce_payment_instruction_posting_claim",
    "config": []
  },
  {
    "name": "entitlement_ledger_append_only_guard",
    "config": []
  },
  {
    "name": "field_ticket_labor_line_immutable_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "field_ticket_labor_snapshot_retention_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "field_ticket_signature_immutable_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "field_ticket_signature_request_guard",
    "config": []
  },
  {
    "name": "financial_change_guard",
    "config": []
  },
  {
    "name": "fulfillment_documents_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "fulfillment_lines_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "fx_rate_age_policy_history_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "goods_tax_registration_history_guard",
    "config": []
  },
  {
    "name": "goods_tax_snapshot_guard",
    "config": []
  },
  {
    "name": "handling_unit_content_history_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "handling_unit_lifecycle_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "hrm_absence_no_delete",
    "config": []
  },
  {
    "name": "hrm_allowance_payroll_input_no_delete",
    "config": []
  },
  {
    "name": "hrm_application_events_immutable",
    "config": []
  },
  {
    "name": "hrm_benefit_award_event_no_delete",
    "config": []
  },
  {
    "name": "hrm_benefit_award_no_delete",
    "config": []
  },
  {
    "name": "hrm_benefit_enrollment_no_delete",
    "config": []
  },
  {
    "name": "hrm_benefit_event_no_delete",
    "config": []
  },
  {
    "name": "hrm_benefit_payroll_input_no_delete",
    "config": []
  },
  {
    "name": "hrm_benefit_program_no_delete",
    "config": []
  },
  {
    "name": "hrm_calibration_event_no_delete",
    "config": []
  },
  {
    "name": "hrm_checklist_publication_guard",
    "config": []
  },
  {
    "name": "hrm_checklist_version_immutable",
    "config": []
  },
  {
    "name": "hrm_compensation_history_guard",
    "config": []
  },
  {
    "name": "hrm_compensation_plans_guard",
    "config": []
  },
  {
    "name": "hrm_compliance_findings_no_delete",
    "config": []
  },
  {
    "name": "hrm_documents_history_guard",
    "config": []
  },
  {
    "name": "hrm_employment_change_request_no_delete",
    "config": []
  },
  {
    "name": "hrm_exit_record_event_no_delete",
    "config": []
  },
  {
    "name": "hrm_exit_record_no_delete",
    "config": []
  },
  {
    "name": "hrm_feedback_no_delete",
    "config": []
  },
  {
    "name": "hrm_goal_update_no_delete",
    "config": []
  },
  {
    "name": "hrm_leave_request_no_delete",
    "config": []
  },
  {
    "name": "hrm_payroll_input_no_delete",
    "config": []
  },
  {
    "name": "hrm_pipeline_template_no_delete",
    "config": []
  },
  {
    "name": "hrm_process_steps_history_guard",
    "config": []
  },
  {
    "name": "hrm_process_template_no_delete",
    "config": []
  },
  {
    "name": "hrm_processes_history_guard",
    "config": []
  },
  {
    "name": "hrm_qualification_events_no_delete",
    "config": []
  },
  {
    "name": "hrm_recruiting_depth_append_only",
    "config": []
  },
  {
    "name": "hrm_recruiting_history_guard",
    "config": []
  },
  {
    "name": "hrm_review_event_no_delete",
    "config": []
  },
  {
    "name": "hrm_review_no_delete",
    "config": []
  },
  {
    "name": "hrm_review_template_no_delete",
    "config": []
  },
  {
    "name": "hrm_scorecard_submitted_immutable",
    "config": []
  },
  {
    "name": "hrm_shift_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "hrm_talent_review_no_delete",
    "config": []
  },
  {
    "name": "hrm_training_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "internal_billing_rules_history_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "inv_move_guard",
    "config": []
  },
  {
    "name": "inventory_count_policy_history_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "inventory_lot_identity_guard",
    "config": []
  },
  {
    "name": "inventory_provisional_immutable",
    "config": []
  },
  {
    "name": "inventory_serial_count_history_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "inventory_serial_lifecycle_guard",
    "config": []
  },
  {
    "name": "je_guard",
    "config": []
  },
  {
    "name": "jl_guard",
    "config": []
  },
  {
    "name": "journal_lines_check_balanced_stmt_del",
    "config": []
  },
  {
    "name": "journal_lines_check_fx_residual_stmt_del",
    "config": []
  },
  {
    "name": "landed_cost_allocation_guard",
    "config": []
  },
  {
    "name": "landed_cost_voucher_guard",
    "config": []
  },
  {
    "name": "landed_cost_voucher_target_guard",
    "config": []
  },
  {
    "name": "lease_agreement_revision_guard",
    "config": []
  },
  {
    "name": "lease_schedule_history_guard",
    "config": []
  },
  {
    "name": "net_investment_configuration_guard",
    "config": []
  },
  {
    "name": "net_investment_evidence_guard",
    "config": []
  },
  {
    "name": "nonprofit_frameworks_guard",
    "config": []
  },
  {
    "name": "openbooks_bank_statement_line_guard",
    "config": []
  },
  {
    "name": "openbooks_gl_activity_entry",
    "config": []
  },
  {
    "name": "openbooks_gl_activity_line",
    "config": []
  },
  {
    "name": "openbooks_guard_ap_capture_evidence",
    "config": []
  },
  {
    "name": "openbooks_guard_ap_capture_source_blob",
    "config": []
  },
  {
    "name": "openbooks_guard_ap_capture_source_file",
    "config": []
  },
  {
    "name": "openbooks_guard_ap_capture_source_version",
    "config": []
  },
  {
    "name": "openbooks_guard_budget_line",
    "config": []
  },
  {
    "name": "openbooks_guard_budget_scenario",
    "config": []
  },
  {
    "name": "openbooks_guard_depreciation_evidence",
    "config": []
  },
  {
    "name": "openbooks_guard_finished_ap_capture_run",
    "config": []
  },
  {
    "name": "openbooks_guard_pay_run_bank_file",
    "config": []
  },
  {
    "name": "openbooks_guard_payroll_bank_file_blob",
    "config": []
  },
  {
    "name": "openbooks_guard_payroll_bank_file_file",
    "config": []
  },
  {
    "name": "openbooks_guard_payroll_bank_file_version",
    "config": []
  },
  {
    "name": "openbooks_party_payment_stats",
    "config": []
  },
  {
    "name": "openbooks_reconciliation_match_guard",
    "config": [
      "search_path=pg_catalog,public"
    ]
  },
  {
    "name": "order_line_cancellations_append_only_guard",
    "config": []
  },
  {
    "name": "org_business_calendars_history_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "pay_component_earning_classifications_prevent_orphan_delete",
    "config": [
      "search_path=pg_catalog,public"
    ]
  },
  {
    "name": "pay_component_history_guard",
    "config": []
  },
  {
    "name": "payment_event_immutable",
    "config": []
  },
  {
    "name": "payment_run_item_guard",
    "config": []
  },
  {
    "name": "payroll_annual_period_bounds_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "payroll_compensation_calculation_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "payroll_compensation_configuration_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "payroll_employee_employer_assignment_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "payroll_holiday_allocation_audit",
    "config": [
      "search_path=pg_catalog,public"
    ]
  },
  {
    "name": "payroll_holiday_allocation_guard",
    "config": [
      "search_path=pg_catalog,public"
    ]
  },
  {
    "name": "payroll_holiday_obligation_guard",
    "config": [
      "search_path=pg_catalog,public"
    ]
  },
  {
    "name": "payroll_period_opening_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "payroll_program_period_bounds_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "payroll_service_configuration_audit",
    "config": []
  },
  {
    "name": "payroll_service_configuration_guard",
    "config": []
  },
  {
    "name": "payroll_work_location_allocation_audit",
    "config": []
  },
  {
    "name": "payroll_work_location_allocation_lock_committed",
    "config": []
  },
  {
    "name": "pick_execution_history_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "position_changes_immutable_guard",
    "config": []
  },
  {
    "name": "position_versions_closure_guard",
    "config": []
  },
  {
    "name": "preserve_historical_compensation_cycle",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "primary_book_history_guard",
    "config": [
      "search_path=pg_catalog,public"
    ]
  },
  {
    "name": "project_delivery_evidence_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "project_financial_adjustment_guard",
    "config": []
  },
  {
    "name": "project_financial_profile_version_guard",
    "config": []
  },
  {
    "name": "project_overhead_adjustment_guard",
    "config": []
  },
  {
    "name": "property_financial_evidence_guard",
    "config": []
  },
  {
    "name": "protect_application_idempotency_key",
    "config": []
  },
  {
    "name": "protect_country_tax_pack_installation",
    "config": []
  },
  {
    "name": "protect_org_base_price_level",
    "config": []
  },
  {
    "name": "protect_pricing_customer_role",
    "config": []
  },
  {
    "name": "protect_tax_provision_history",
    "config": []
  },
  {
    "name": "protect_temporary_difference_history",
    "config": []
  },
  {
    "name": "provision_identity_guard",
    "config": []
  },
  {
    "name": "rate_adjustment_target_version_guard",
    "config": []
  },
  {
    "name": "rate_book_currency_guard",
    "config": []
  },
  {
    "name": "rate_version_child_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "rate_version_immutable",
    "config": []
  },
  {
    "name": "recognition_revision_history_guard",
    "config": []
  },
  {
    "name": "recurring_occurrence_document_immutable_guard",
    "config": []
  },
  {
    "name": "reporting_relationships_closure_guard",
    "config": []
  },
  {
    "name": "saas_metrics_fx_evidence_guard",
    "config": []
  },
  {
    "name": "saas_metrics_normalization_request_guard",
    "config": []
  },
  {
    "name": "sales_evidence_immutable",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "sales_quota_version_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "schedule_boards_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "schedule_codes_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "schedule_distribution_snapshot_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "schedule_entries_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "schedule_source_records_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "scheduler_outbox_terminal_audit_append_only_guard",
    "config": []
  },
  {
    "name": "segment_definition_guard",
    "config": []
  },
  {
    "name": "segment_values_clear_default_for_wipe",
    "config": []
  },
  {
    "name": "stored_value_entries_immutable",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "subscription_amendment_immutable_guard",
    "config": []
  },
  {
    "name": "subscription_period_invoice_immutable_guard",
    "config": []
  },
  {
    "name": "subscription_plan_version_immutable_guard",
    "config": []
  },
  {
    "name": "subscription_version_component_immutable_guard",
    "config": []
  },
  {
    "name": "subsidiary_tree_guard",
    "config": []
  },
  {
    "name": "tax_filing_immutable_guard",
    "config": []
  },
  {
    "name": "trg_application_open_balance",
    "config": []
  },
  {
    "name": "trg_journal_line_open_balance",
    "config": []
  },
  {
    "name": "usage_prepaid_draws_append_only_guard",
    "config": []
  },
  {
    "name": "usage_rating_bands_draft_only_guard",
    "config": []
  },
  {
    "name": "usage_rating_published_immutable_guard",
    "config": []
  },
  {
    "name": "warehouse_execution_history_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "warehouse_execution_task_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "prebill_event_append_only_guard",
    "config": []
  },
  {
    "name": "withholding_deductions_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "withholding_returns_guard",
    "config": [
      "search_path=public,pg_catalog"
    ]
  },
  {
    "name": "worker_employment_versions_closure_guard",
    "config": []
  }
] as const;

export const TENANT_RETIREMENT_TRIGGER_CONTRACTS = [
  {
    "table": "ap_capture_corrections",
    "trigger": "ap_capture_corrections_append_only",
    "function": "openbooks_guard_ap_capture_evidence"
  },
  {
    "table": "ap_capture_events",
    "trigger": "ap_capture_events_append_only",
    "function": "openbooks_guard_ap_capture_evidence"
  },
  {
    "table": "ap_capture_fields",
    "trigger": "ap_capture_fields_append_only",
    "function": "openbooks_guard_ap_capture_evidence"
  },
  {
    "table": "ap_capture_runs",
    "trigger": "ap_capture_runs_immutable",
    "function": "openbooks_guard_finished_ap_capture_run"
  },
  {
    "table": "file_blobs",
    "trigger": "ap_capture_source_blob_immutable",
    "function": "openbooks_guard_ap_capture_source_blob"
  },
  {
    "table": "files",
    "trigger": "ap_capture_source_file_immutable",
    "function": "openbooks_guard_ap_capture_source_file"
  },
  {
    "table": "file_versions",
    "trigger": "ap_capture_source_version_immutable",
    "function": "openbooks_guard_ap_capture_source_version"
  },
  {
    "table": "applications",
    "trigger": "application_evidence_guard",
    "function": "application_evidence_guard"
  },
  {
    "table": "application_idempotency_keys",
    "trigger": "application_idempotency_guard",
    "function": "protect_application_idempotency_key"
  },
  {
    "table": "applications",
    "trigger": "application_open_balance",
    "function": "trg_application_open_balance"
  },
  {
    "table": "asset_events",
    "trigger": "asset_event_append_only_guard",
    "function": "asset_event_append_only_guard"
  },
  {
    "table": "audit_log",
    "trigger": "audit_log_append_only",
    "function": "audit_log_append_only_guard"
  },
  {
    "table": "bank_statement_lines",
    "trigger": "bank_statement_line_guard",
    "function": "openbooks_bank_statement_line_guard"
  },
  {
    "table": "billing_request_field_tickets",
    "trigger": "billing_request_field_ticket_guard",
    "function": "billing_request_field_ticket_guard"
  },
  {
    "table": "budget_lines",
    "trigger": "budget_line_guard",
    "function": "openbooks_guard_budget_line"
  },
  {
    "table": "budget_scenarios",
    "trigger": "budget_scenario_guard",
    "function": "openbooks_guard_budget_scenario"
  },
  {
    "table": "close_events",
    "trigger": "close_events_append_only",
    "function": "close_append_only_guard"
  },
  {
    "table": "close_task_evidence",
    "trigger": "close_evidence_append_only",
    "function": "close_append_only_guard"
  },
  {
    "table": "close_signoffs",
    "trigger": "close_signoffs_append_only",
    "function": "close_append_only_guard"
  },
  {
    "table": "tax_country_pack_installations",
    "trigger": "country_tax_pack_installation_guard",
    "function": "protect_country_tax_pack_installation"
  },
  {
    "table": "file_attachments",
    "trigger": "depreciation_evidence_attachment_guard",
    "function": "depreciation_evidence_attachment_guard"
  },
  {
    "table": "depreciation_inputs",
    "trigger": "depreciation_input_evidence_guard",
    "function": "openbooks_guard_depreciation_evidence"
  },
  {
    "table": "document_links",
    "trigger": "document_correction_lineage_guard",
    "function": "document_correction_lineage_guard"
  },
  {
    "table": "document_line_tax_components",
    "trigger": "document_line_tax_component_guard",
    "function": "document_line_tax_component_guard"
  },
  {
    "table": "dunning_log",
    "trigger": "dunning_log_no_mutate",
    "function": "dunning_log_guard"
  },
  {
    "table": "entitlement_ledger",
    "trigger": "entitlement_ledger_append_only",
    "function": "entitlement_ledger_append_only_guard"
  },
  {
    "table": "field_ticket_labor_lines",
    "trigger": "field_ticket_labor_line_immutable",
    "function": "field_ticket_labor_line_immutable_guard"
  },
  {
    "table": "field_ticket_labor_snapshots",
    "trigger": "field_ticket_labor_snapshot_retention",
    "function": "field_ticket_labor_snapshot_retention_guard"
  },
  {
    "table": "field_ticket_signatures",
    "trigger": "field_ticket_signature_immutable",
    "function": "field_ticket_signature_immutable_guard"
  },
  {
    "table": "field_ticket_signature_requests",
    "trigger": "field_ticket_signature_request_immutable",
    "function": "field_ticket_signature_request_guard"
  },
  {
    "table": "journal_entries",
    "trigger": "gl_activity_entry",
    "function": "openbooks_gl_activity_entry"
  },
  {
    "table": "journal_lines",
    "trigger": "gl_activity_line",
    "function": "openbooks_gl_activity_line"
  },
  {
    "table": "inventory_movements",
    "trigger": "inv_move_guard",
    "function": "inv_move_guard"
  },
  {
    "table": "lots",
    "trigger": "inventory_lot_identity_guard_trigger",
    "function": "inventory_lot_identity_guard"
  },
  {
    "table": "inventory_provisional_costs",
    "trigger": "inventory_provisional_cost_delete",
    "function": "inventory_provisional_immutable"
  },
  {
    "table": "inventory_provisional_settlements",
    "trigger": "inventory_provisional_settlement_immutable",
    "function": "inventory_provisional_immutable"
  },
  {
    "table": "serials",
    "trigger": "inventory_serial_lifecycle_guard_trigger",
    "function": "inventory_serial_lifecycle_guard"
  },
  {
    "table": "item_rate_books",
    "trigger": "item_rate_books_currency_guard",
    "function": "rate_book_currency_guard"
  },
  {
    "table": "item_rate_lines",
    "trigger": "item_rate_lines_version_guard",
    "function": "rate_version_child_guard"
  },
  {
    "table": "item_rate_versions",
    "trigger": "item_rate_versions_immutable",
    "function": "rate_version_immutable"
  },
  {
    "table": "journal_entries",
    "trigger": "je_guard",
    "function": "je_guard"
  },
  {
    "table": "journal_lines",
    "trigger": "jl_guard",
    "function": "jl_guard"
  },
  {
    "table": "labor_rate_adjustment_targets",
    "trigger": "labor_rate_adjustment_targets_version_guard",
    "function": "rate_adjustment_target_version_guard"
  },
  {
    "table": "labor_rate_adjustments",
    "trigger": "labor_rate_adjustments_version_guard",
    "function": "rate_version_child_guard"
  },
  {
    "table": "labor_rate_terms",
    "trigger": "labor_rate_terms_version_guard",
    "function": "rate_version_child_guard"
  },
  {
    "table": "labor_rate_version_policies",
    "trigger": "labor_rate_version_policies_version_guard",
    "function": "rate_version_child_guard"
  },
  {
    "table": "labor_rate_version_scopes",
    "trigger": "labor_rate_version_scopes_version_guard",
    "function": "rate_version_child_guard"
  },
  {
    "table": "landed_cost_allocations",
    "trigger": "landed_cost_allocation_guard_trigger",
    "function": "landed_cost_allocation_guard"
  },
  {
    "table": "landed_cost_vouchers",
    "trigger": "landed_cost_voucher_guard_trigger",
    "function": "landed_cost_voucher_guard"
  },
  {
    "table": "landed_cost_voucher_targets",
    "trigger": "landed_cost_voucher_target_guard_trigger",
    "function": "landed_cost_voucher_target_guard"
  },
  {
    "table": "lease_escalations",
    "trigger": "lease_escalations_applied_append_only",
    "function": "property_financial_evidence_guard"
  },
  {
    "table": "pay_run_bank_files",
    "trigger": "pay_run_bank_file_immutable",
    "function": "openbooks_guard_pay_run_bank_file"
  },
  {
    "table": "payment_events",
    "trigger": "payment_event_immutable",
    "function": "payment_event_immutable"
  },
  {
    "table": "applications",
    "trigger": "party_payment_stats_maintain",
    "function": "openbooks_party_payment_stats"
  },
  {
    "table": "payment_run_items",
    "trigger": "payment_run_item_guard",
    "function": "payment_run_item_guard"
  },
  {
    "table": "file_blobs",
    "trigger": "payroll_bank_file_blob_immutable",
    "function": "openbooks_guard_payroll_bank_file_blob"
  },
  {
    "table": "files",
    "trigger": "payroll_bank_file_file_immutable",
    "function": "openbooks_guard_payroll_bank_file_file"
  },
  {
    "table": "file_versions",
    "trigger": "payroll_bank_file_version_immutable",
    "function": "openbooks_guard_payroll_bank_file_version"
  },
  {
    "table": "project_financial_adjustments",
    "trigger": "project_financial_adjustment_guard",
    "function": "project_financial_adjustment_guard"
  },
  {
    "table": "project_financial_profile_versions",
    "trigger": "project_financial_profile_version_guard",
    "function": "project_financial_profile_version_guard"
  },
  {
    "table": "project_overhead_adjustments",
    "trigger": "project_overhead_adjustment_guard",
    "function": "project_overhead_adjustment_guard"
  },
  {
    "table": "reconciliation_matches",
    "trigger": "reconciliation_match_guard",
    "function": "openbooks_reconciliation_match_guard"
  },
  {
    "table": "role_assignments",
    "trigger": "role_assignments_active_user_guard",
    "function": "enforce_deleted_role_assignment"
  },
  {
    "table": "security_deposit_transactions",
    "trigger": "security_deposits_append_only",
    "function": "property_financial_evidence_guard"
  },
  {
    "table": "segment_definitions",
    "trigger": "segment_definition_guard",
    "function": "segment_definition_guard"
  },
  {
    "table": "subscription_amendments",
    "trigger": "subscription_amendment_immutable",
    "function": "subscription_amendment_immutable_guard"
  },
  {
    "table": "subscription_period_invoices",
    "trigger": "subscription_period_invoice_immutable",
    "function": "subscription_period_invoice_immutable_guard"
  },
  {
    "table": "subscription_plan_versions",
    "trigger": "subscription_plan_version_immutable",
    "function": "subscription_plan_version_immutable_guard"
  },
  {
    "table": "subscription_plan_version_components",
    "trigger": "subscription_version_component_immutable",
    "function": "subscription_version_component_immutable_guard"
  },
  {
    "table": "subsidiaries",
    "trigger": "subsidiary_tree_guard",
    "function": "subsidiary_tree_guard"
  },
  {
    "table": "tax_filings",
    "trigger": "tax_filing_immutable",
    "function": "tax_filing_immutable_guard"
  },
  {
    "table": "tax_provision_runs",
    "trigger": "tax_provision_history_guard",
    "function": "protect_tax_provision_history"
  },
  {
    "table": "temporary_differences",
    "trigger": "temporary_difference_history_guard",
    "function": "protect_temporary_difference_history"
  },
  {
    "table": "prebill_events",
    "trigger": "prebill_event_append_only",
    "function": "prebill_event_append_only_guard"
  },
  {
    "table": "recurring_occurrence_documents",
    "trigger": "recurring_occurrence_document_immutable",
    "function": "recurring_occurrence_document_immutable_guard"
  },
  {
    "table": "payment_instructions",
    "trigger": "payment_instructions_posting_claim_fence",
    "function": "enforce_payment_instruction_posting_claim"
  },
  {
    "table": "document_lines",
    "trigger": "document_lines_total_line_refresh",
    "function": "document_lines_total_line_refresh"
  },
  {
    "table": "document_lines",
    "trigger": "document_lines_total_line_tieout",
    "function": "document_lines_total_line_tieout"
  },
  {
    "table": "scheduler_outbox_terminal_audit",
    "trigger": "scheduler_outbox_terminal_audit_append_only",
    "function": "scheduler_outbox_terminal_audit_append_only_guard"
  },
  {
    "table": "document_lines",
    "trigger": "document_line_immutability",
    "function": "document_line_immutability_guard"
  },
  {
    "table": "change_set_items",
    "trigger": "change_set_items_lifecycle_guard",
    "function": "change_set_items_lifecycle_guard"
  },
  {
    "table": "account_group_members",
    "trigger": "account_group_member_scope_guard",
    "function": "account_group_member_scope_guard"
  },
  {
    "table": "pay_components",
    "trigger": "pay_component_history_guard",
    "function": "pay_component_history_guard"
  },
  {
    "table": "accounting_books",
    "trigger": "primary_book_history_guard",
    "function": "primary_book_history_guard"
  },
  {
    "table": "depreciation_book_policies",
    "trigger": "depreciation_book_policy_history_guard",
    "function": "depreciation_book_policy_history_guard"
  },
  {
    "table": "allocation_rule_targets",
    "trigger": "allocation_rule_target_guard",
    "function": "allocation_rule_target_guard"
  },
  {
    "table": "worker_employment_versions",
    "trigger": "worker_employment_versions_closure",
    "function": "worker_employment_versions_closure_guard"
  },
  {
    "table": "employment_assignment_versions",
    "trigger": "employment_assignment_versions_closure",
    "function": "employment_assignment_versions_closure_guard"
  },
  {
    "table": "reporting_relationships",
    "trigger": "reporting_relationships_closure",
    "function": "reporting_relationships_closure_guard"
  },
  {
    "table": "employment_changes",
    "trigger": "employment_changes_immutable",
    "function": "employment_changes_immutable_guard"
  },
  {
    "table": "hrm_employment_change_requests",
    "trigger": "hrm_employment_change_request_no_delete_trigger",
    "function": "hrm_employment_change_request_no_delete"
  },
  {
    "table": "position_versions",
    "trigger": "position_versions_closure",
    "function": "position_versions_closure_guard"
  },
  {
    "table": "position_changes",
    "trigger": "position_changes_immutable",
    "function": "position_changes_immutable_guard"
  },
  {
    "table": "hrm_process_templates",
    "trigger": "hrm_process_template_no_delete",
    "function": "hrm_process_template_no_delete"
  },
  {
    "table": "hrm_processes",
    "trigger": "hrm_processes_history",
    "function": "hrm_processes_history_guard"
  },
  {
    "table": "hrm_process_steps",
    "trigger": "hrm_process_steps_history",
    "function": "hrm_process_steps_history_guard"
  },
  {
    "table": "hrm_absences",
    "trigger": "hrm_absence_no_delete_trigger",
    "function": "hrm_absence_no_delete"
  },
  {
    "table": "hrm_leave_requests",
    "trigger": "hrm_leave_request_no_delete_trigger",
    "function": "hrm_leave_request_no_delete"
  },
  {
    "table": "hrm_payroll_inputs",
    "trigger": "hrm_payroll_input_no_delete_trigger",
    "function": "hrm_payroll_input_no_delete"
  },
  {
    "table": "hrm_pipeline_templates",
    "trigger": "hrm_pipeline_template_no_delete",
    "function": "hrm_pipeline_template_no_delete"
  },
  {
    "table": "hrm_application_events",
    "trigger": "hrm_application_events_immutable",
    "function": "hrm_application_events_immutable"
  },
  {
    "table": "hrm_requisitions",
    "trigger": "hrm_requisitions_history",
    "function": "hrm_recruiting_history_guard"
  },
  {
    "table": "hrm_applications",
    "trigger": "hrm_applications_history",
    "function": "hrm_recruiting_history_guard"
  },
  {
    "table": "hrm_interviews",
    "trigger": "hrm_interviews_history",
    "function": "hrm_recruiting_history_guard"
  },
  {
    "table": "hrm_offers",
    "trigger": "hrm_offers_history",
    "function": "hrm_recruiting_history_guard"
  },
  {
    "table": "hrm_review_events",
    "trigger": "hrm_review_event_no_delete_trigger",
    "function": "hrm_review_event_no_delete"
  },
  {
    "table": "hrm_goal_updates",
    "trigger": "hrm_goal_update_no_delete_trigger",
    "function": "hrm_goal_update_no_delete"
  },
  {
    "table": "hrm_reviews",
    "trigger": "hrm_review_no_delete_trigger",
    "function": "hrm_review_no_delete"
  },
  {
    "table": "hrm_exit_records",
    "trigger": "hrm_exit_record_no_delete_trigger",
    "function": "hrm_exit_record_no_delete"
  },
  {
    "table": "hrm_review_templates",
    "trigger": "hrm_review_template_no_delete_trigger",
    "function": "hrm_review_template_no_delete"
  },
  {
    "table": "hrm_benefit_events",
    "trigger": "hrm_benefit_event_no_delete_trigger",
    "function": "hrm_benefit_event_no_delete"
  },
  {
    "table": "hrm_benefit_enrollments",
    "trigger": "hrm_benefit_enrollment_no_delete_trigger",
    "function": "hrm_benefit_enrollment_no_delete"
  },
  {
    "table": "hrm_benefit_payroll_inputs",
    "trigger": "hrm_benefit_payroll_input_no_delete_trigger",
    "function": "hrm_benefit_payroll_input_no_delete"
  },
  {
    "table": "financial_changes",
    "trigger": "financial_change_guard",
    "function": "financial_change_guard"
  },
  {
    "table": "lease_agreement_schedule_lines",
    "trigger": "lease_schedule_history_guard",
    "function": "lease_schedule_history_guard"
  },
  {
    "table": "lease_agreements",
    "trigger": "lease_agreement_revision_guard",
    "function": "lease_agreement_revision_guard"
  },
  {
    "table": "recognition_schedule_lines",
    "trigger": "recognition_revision_history_guard",
    "function": "recognition_revision_history_guard"
  },
  {
    "table": "asset_basis_changes",
    "trigger": "asset_basis_change_guard",
    "function": "asset_basis_change_guard"
  },
  {
    "table": "asset_transfer_bases",
    "trigger": "asset_transfer_history_guard",
    "function": "asset_transfer_history_guard"
  },
  {
    "table": "asset_transfer_consolidation_entries",
    "trigger": "asset_transfer_history_guard",
    "function": "asset_transfer_history_guard"
  },
  {
    "table": "asset_transfer_measurements",
    "trigger": "asset_transfer_measurement_guard",
    "function": "asset_transfer_measurement_guard"
  },
  {
    "table": "consolidation_control_losses",
    "trigger": "control_loss_history_guard",
    "function": "control_loss_history_guard"
  },
  {
    "table": "consolidated_fx_rates",
    "trigger": "control_loss_rate_guard",
    "function": "control_loss_source_guard"
  },
  {
    "table": "hrm_comp_events",
    "trigger": "hrm_comp_events_immutable",
    "function": "hrm_compensation_history_guard"
  },
  {
    "table": "hrm_pay_bands",
    "trigger": "hrm_pay_bands_history",
    "function": "hrm_compensation_history_guard"
  },
  {
    "table": "hrm_comp_cycle_lines",
    "trigger": "hrm_comp_cycle_lines_history",
    "function": "hrm_compensation_history_guard"
  },
  {
    "table": "hrm_comp_statements",
    "trigger": "hrm_comp_statements_history",
    "function": "hrm_compensation_history_guard"
  },
  {
    "table": "hrm_pay_gap_snapshots",
    "trigger": "hrm_pay_gap_snapshots_frozen",
    "function": "hrm_compensation_plans_guard"
  },
  {
    "table": "hrm_headcount_plans",
    "trigger": "hrm_headcount_plans_history",
    "function": "hrm_compensation_plans_guard"
  },
  {
    "table": "hrm_headcount_plan_lines",
    "trigger": "hrm_headcount_plan_lines_history",
    "function": "hrm_compensation_plans_guard"
  },
  {
    "table": "hrm_pay_information_requests",
    "trigger": "hrm_pay_information_requests_history",
    "function": "hrm_compensation_plans_guard"
  },
  {
    "table": "hrm_allowance_payroll_inputs",
    "trigger": "hrm_allowance_payroll_input_no_delete_trigger",
    "function": "hrm_allowance_payroll_input_no_delete"
  },
  {
    "table": "hrm_compliance_findings",
    "trigger": "hrm_compliance_findings_no_delete_trigger",
    "function": "hrm_compliance_findings_no_delete"
  },
  {
    "table": "hrm_qualification_events",
    "trigger": "hrm_qualification_events_no_delete_trigger",
    "function": "hrm_qualification_events_no_delete"
  },
  {
    "table": "hrm_feedback",
    "trigger": "hrm_feedback_no_delete_trigger",
    "function": "hrm_feedback_no_delete"
  },
  {
    "table": "hrm_calibration_events",
    "trigger": "hrm_calibration_event_no_delete_trigger",
    "function": "hrm_calibration_event_no_delete"
  },
  {
    "table": "hrm_talent_reviews",
    "trigger": "hrm_talent_review_no_delete_trigger",
    "function": "hrm_talent_review_no_delete"
  },
  {
    "table": "hrm_scorecards",
    "trigger": "hrm_scorecards_submitted_immutable",
    "function": "hrm_scorecard_submitted_immutable"
  },
  {
    "table": "hrm_offer_versions",
    "trigger": "hrm_offer_versions_append_only",
    "function": "hrm_recruiting_depth_append_only"
  },
  {
    "table": "hrm_posting_events",
    "trigger": "hrm_posting_events_append_only",
    "function": "hrm_recruiting_depth_append_only"
  },
  {
    "table": "hrm_retention_runs",
    "trigger": "hrm_retention_runs_append_only",
    "function": "hrm_recruiting_depth_append_only"
  },
  {
    "table": "hrm_document_events",
    "trigger": "hrm_document_events_immutable",
    "function": "hrm_documents_history_guard"
  },
  {
    "table": "hrm_retention_actions",
    "trigger": "hrm_retention_actions_immutable",
    "function": "hrm_documents_history_guard"
  },
  {
    "table": "hrm_survey_responses",
    "trigger": "hrm_survey_responses_immutable",
    "function": "hrm_documents_history_guard"
  },
  {
    "table": "ai_decisions",
    "trigger": "ai_decisions_refuse_update",
    "function": "ai_decisions_refuse_update"
  },
  {
    "table": "depreciation_schedule_lines",
    "trigger": "depreciation_non_gl_recognition_guard",
    "function": "depreciation_non_gl_recognition_guard"
  },
  {
    "table": "price_levels",
    "trigger": "price_level_base_guard",
    "function": "protect_org_base_price_level"
  },
  {
    "table": "customer_roles",
    "trigger": "customer_role_pricing_guard",
    "function": "protect_pricing_customer_role"
  },
  {
    "table": "hrm_exit_record_events",
    "trigger": "hrm_exit_record_event_no_delete_trigger",
    "function": "hrm_exit_record_event_no_delete"
  },
  {
    "table": "journal_lines",
    "trigger": "journal_line_open_balance",
    "function": "trg_journal_line_open_balance"
  },
  {
    "table": "pay_component_earning_classifications",
    "trigger": "pay_component_earning_classifications_protect_parent",
    "function": "pay_component_earning_classifications_prevent_orphan_delete"
  },
  {
    "table": "payroll_work_location_allocations",
    "trigger": "payroll_work_location_allocation_lock_committed",
    "function": "payroll_work_location_allocation_lock_committed"
  },
  {
    "table": "payroll_work_location_allocations",
    "trigger": "payroll_work_location_allocation_audit",
    "function": "payroll_work_location_allocation_audit"
  },
  {
    "table": "journal_lines",
    "trigger": "journal_lines_balanced_stmt_del",
    "function": "journal_lines_check_balanced_stmt_del"
  },
  {
    "table": "fulfillment_documents",
    "trigger": "fulfillment_documents_guard",
    "function": "fulfillment_documents_guard"
  },
  {
    "table": "fulfillment_lines",
    "trigger": "fulfillment_lines_guard",
    "function": "fulfillment_lines_guard"
  },
  {
    "table": "order_line_cancellations",
    "trigger": "order_line_cancellations_append_only",
    "function": "order_line_cancellations_append_only_guard"
  },
  {
    "table": "usage_rating_plan_versions",
    "trigger": "usage_rating_plan_versions_immutable",
    "function": "usage_rating_published_immutable_guard"
  },
  {
    "table": "usage_rating_bands",
    "trigger": "usage_rating_bands_draft_only",
    "function": "usage_rating_bands_draft_only_guard"
  },
  {
    "table": "usage_prepaid_draws",
    "trigger": "usage_prepaid_draws_append_only",
    "function": "usage_prepaid_draws_append_only_guard"
  },
  {
    "table": "segment_values",
    "trigger": "segment_values_clear_default_for_wipe",
    "function": "segment_values_clear_default_for_wipe"
  },
  {
    "table": "nonprofit_frameworks",
    "trigger": "nonprofit_frameworks_guard",
    "function": "nonprofit_frameworks_guard"
  },
  {
    "table": "saas_metrics_fx_evidence",
    "trigger": "saas_metrics_fx_evidence_guard",
    "function": "saas_metrics_fx_evidence_guard"
  },
  {
    "table": "saas_metrics_normalization_requests",
    "trigger": "saas_metrics_normalization_requests_guard",
    "function": "saas_metrics_normalization_request_guard"
  },
  {
    "table": "journal_lines",
    "trigger": "journal_lines_fx_residual_stmt_del",
    "function": "journal_lines_check_fx_residual_stmt_del"
  },
  {
    "table": "provision_obligations",
    "trigger": "provision_identity_immutable",
    "function": "provision_identity_guard"
  },
  {
    "table": "assembly_disassemblies",
    "trigger": "assembly_disassembly_immutable",
    "function": "assembly_disassembly_immutable"
  },
  {
    "table": "drop_ship_agent_allocations",
    "trigger": "drop_ship_allocation_guard",
    "function": "drop_ship_allocation_guard"
  },
  {
    "table": "net_investment_entries",
    "trigger": "net_investment_evidence_guard",
    "function": "net_investment_evidence_guard"
  },
  {
    "table": "net_investment_sources",
    "trigger": "net_investment_evidence_guard",
    "function": "net_investment_evidence_guard"
  },
  {
    "table": "subsidiary_ownership_interests",
    "trigger": "net_investment_configuration_guard",
    "function": "net_investment_configuration_guard"
  },
  {
    "table": "intercompany_pairs",
    "trigger": "net_investment_configuration_guard",
    "function": "net_investment_configuration_guard"
  },
  {
    "table": "consolidated_fx_rates",
    "trigger": "net_investment_configuration_guard",
    "function": "net_investment_configuration_guard"
  },
  {
    "table": "document_goods_tax_snapshots",
    "trigger": "goods_tax_snapshot_guard",
    "function": "goods_tax_snapshot_guard"
  },
  {
    "table": "tax_registrations",
    "trigger": "goods_tax_registration_history_guard",
    "function": "goods_tax_registration_history_guard"
  },
  {
    "table": "hrm_benefit_programs",
    "trigger": "hrm_benefit_program_no_delete_trigger",
    "function": "hrm_benefit_program_no_delete"
  },
  {
    "table": "hrm_benefit_awards",
    "trigger": "hrm_benefit_award_no_delete_trigger",
    "function": "hrm_benefit_award_no_delete"
  },
  {
    "table": "hrm_benefit_award_events",
    "trigger": "hrm_benefit_award_event_no_delete_trigger",
    "function": "hrm_benefit_award_event_no_delete"
  },
  {
    "table": "crm_sales_evidence",
    "trigger": "sales_evidence_immutable",
    "function": "sales_evidence_immutable"
  },
  {
    "table": "crm_sales_territory_versions",
    "trigger": "sales_territory_version_immutable",
    "function": "sales_evidence_immutable"
  },
  {
    "table": "crm_sales_quotas",
    "trigger": "sales_quota_version_guard",
    "function": "sales_quota_version_guard"
  },
  {
    "table": "data_transfer_chunks",
    "trigger": "data_transfer_chunks_evidence_guard",
    "function": "data_transfer_evidence_guard"
  },
  {
    "table": "data_transfer_rows",
    "trigger": "data_transfer_rows_evidence_guard",
    "function": "data_transfer_evidence_guard"
  },
  {
    "table": "data_transfer_events",
    "trigger": "data_transfer_events_evidence_guard",
    "function": "data_transfer_evidence_guard"
  },
  {
    "table": "hrm_benefit_recovery_sources",
    "trigger": "benefit_recovery_source_trigger",
    "function": "benefit_recovery_source_guard"
  },
  {
    "table": "hrm_benefit_contribution_rules",
    "trigger": "benefit_rule_history_trigger",
    "function": "benefit_recurring_history_guard"
  },
  {
    "table": "hrm_benefit_enrollment_terms",
    "trigger": "benefit_term_history_trigger",
    "function": "benefit_recurring_history_guard"
  },
  {
    "table": "hrm_benefit_contribution_tiers",
    "trigger": "benefit_tier_history_trigger",
    "function": "benefit_recurring_history_guard"
  },
  {
    "table": "pay_run_benefit_allocations",
    "trigger": "benefit_allocation_history_trigger",
    "function": "benefit_recurring_history_guard"
  },
  {
    "table": "hrm_benefit_contribution_classes",
    "trigger": "benefit_recurring_audit_trigger",
    "function": "benefit_recurring_audit"
  },
  {
    "table": "hrm_benefit_contribution_tiers",
    "trigger": "benefit_recurring_audit_trigger",
    "function": "benefit_recurring_audit"
  },
  {
    "table": "hrm_benefit_contribution_rules",
    "trigger": "benefit_recurring_audit_trigger",
    "function": "benefit_recurring_audit"
  },
  {
    "table": "hrm_benefit_recovery_sources",
    "trigger": "benefit_recurring_audit_trigger",
    "function": "benefit_recurring_audit"
  },
  {
    "table": "hrm_benefit_enrollment_terms",
    "trigger": "benefit_recurring_audit_trigger",
    "function": "benefit_recurring_audit"
  },
  {
    "table": "pay_run_benefit_allocations",
    "trigger": "benefit_recurring_audit_trigger",
    "function": "benefit_recurring_audit"
  },
  {
    "table": "hrm_benefit_contribution_classes",
    "trigger": "benefit_recurring_configuration_lock_trigger",
    "function": "benefit_recurring_configuration_lock"
  },
  {
    "table": "hrm_benefit_contribution_tiers",
    "trigger": "benefit_recurring_configuration_lock_trigger",
    "function": "benefit_recurring_configuration_lock"
  },
  {
    "table": "hrm_benefit_contribution_rules",
    "trigger": "benefit_recurring_configuration_lock_trigger",
    "function": "benefit_recurring_configuration_lock"
  },
  {
    "table": "hrm_benefit_recovery_sources",
    "trigger": "benefit_recurring_configuration_lock_trigger",
    "function": "benefit_recurring_configuration_lock"
  },
  {
    "table": "hrm_benefit_enrollment_terms",
    "trigger": "benefit_recurring_configuration_lock_trigger",
    "function": "benefit_recurring_configuration_lock"
  },
  {
    "table": "hrm_benefit_enrollments",
    "trigger": "benefit_enrollment_configuration_lock_trigger",
    "function": "benefit_recurring_configuration_lock"
  },
  {
    "table": "hrm_benefit_plans",
    "trigger": "benefit_plan_configuration_lock_trigger",
    "function": "benefit_recurring_configuration_lock"
  },
  {
    "table": "payroll_vacation_terms",
    "trigger": "payroll_vacation_terms_history",
    "function": "payroll_service_configuration_guard"
  },
  {
    "table": "payroll_service_credits",
    "trigger": "payroll_service_credits_history",
    "function": "payroll_service_configuration_guard"
  },
  {
    "table": "entitlement_service_tiers",
    "trigger": "entitlement_service_tiers_history",
    "function": "payroll_service_configuration_guard"
  },
  {
    "table": "payroll_vacation_terms",
    "trigger": "payroll_vacation_terms_audit",
    "function": "payroll_service_configuration_audit"
  },
  {
    "table": "payroll_service_credits",
    "trigger": "payroll_service_credits_audit",
    "function": "payroll_service_configuration_audit"
  },
  {
    "table": "entitlement_service_tiers",
    "trigger": "entitlement_service_tiers_audit",
    "function": "payroll_service_configuration_audit"
  },
  {
    "table": "hrm_process_template_versions",
    "trigger": "hrm_checklist_version_immutable",
    "function": "hrm_checklist_version_immutable"
  },
  {
    "table": "hrm_process_template_steps",
    "trigger": "hrm_checklist_step_publication_guard",
    "function": "hrm_checklist_publication_guard"
  },
  {
    "table": "hrm_benefit_catalog",
    "trigger": "benefit_catalog_identity_guard_trigger",
    "function": "benefit_catalog_identity_guard"
  },
  {
    "table": "document_tenders",
    "trigger": "document_tender_lifecycle",
    "function": "document_tender_lifecycle_guard"
  },
  {
    "table": "stored_value_entries",
    "trigger": "stored_value_entries_immutable_trigger",
    "function": "stored_value_entries_immutable"
  },
  {
    "table": "contract_cost_amortization",
    "trigger": "contract_cost_amortization_immutable_trigger",
    "function": "contract_cost_amortization_immutable"
  },
  {
    "table": "document_supply_evidence",
    "trigger": "document_supply_evidence_guard",
    "function": "document_supply_evidence_guard"
  },
  {
    "table": "fx_rate_age_policies",
    "trigger": "fx_rate_age_policy_history_guard",
    "function": "fx_rate_age_policy_history_guard"
  },
  {
    "table": "payroll_compensation_calculations",
    "trigger": "payroll_compensation_calculation_history",
    "function": "payroll_compensation_calculation_guard"
  },
  {
    "table": "payroll_compensation_packages",
    "trigger": "payroll_compensation_configuration",
    "function": "payroll_compensation_configuration_guard"
  },
  {
    "table": "payroll_compensation_versions",
    "trigger": "payroll_compensation_configuration",
    "function": "payroll_compensation_configuration_guard"
  },
  {
    "table": "payroll_compensation_assignments",
    "trigger": "payroll_compensation_configuration",
    "function": "payroll_compensation_configuration_guard"
  },
  {
    "table": "hrm_shift_templates",
    "trigger": "hrm_shift_guard",
    "function": "hrm_shift_guard"
  },
  {
    "table": "hrm_shift_assignments",
    "trigger": "hrm_shift_guard",
    "function": "hrm_shift_guard"
  },
  {
    "table": "hrm_shift_publications",
    "trigger": "hrm_shift_guard",
    "function": "hrm_shift_guard"
  },
  {
    "table": "hrm_shifts",
    "trigger": "hrm_shift_guard",
    "function": "hrm_shift_guard"
  },
  {
    "table": "hrm_shift_requests",
    "trigger": "hrm_shift_guard",
    "function": "hrm_shift_guard"
  },
  {
    "table": "hrm_attendance_devices",
    "trigger": "hrm_shift_guard",
    "function": "hrm_shift_guard"
  },
  {
    "table": "hrm_attendance_identities",
    "trigger": "hrm_shift_guard",
    "function": "hrm_shift_guard"
  },
  {
    "table": "hrm_attendance_batches",
    "trigger": "hrm_shift_guard",
    "function": "hrm_shift_guard"
  },
  {
    "table": "hrm_attendance_events",
    "trigger": "hrm_shift_guard",
    "function": "hrm_shift_guard"
  },
  {
    "table": "hrm_attendance_watermarks",
    "trigger": "hrm_shift_guard",
    "function": "hrm_shift_guard"
  },
  {
    "table": "hrm_attendance_observations",
    "trigger": "hrm_shift_guard",
    "function": "hrm_shift_guard"
  },
  {
    "table": "hrm_attendance_event_claims",
    "trigger": "hrm_shift_guard",
    "function": "hrm_shift_guard"
  },
  {
    "table": "hrm_attendance_observation_events",
    "trigger": "hrm_shift_guard",
    "function": "hrm_shift_guard"
  },
  {
    "table": "hrm_training_courses",
    "trigger": "hrm_training_guard",
    "function": "hrm_training_guard"
  },
  {
    "table": "hrm_training_sessions",
    "trigger": "hrm_training_guard",
    "function": "hrm_training_guard"
  },
  {
    "table": "hrm_training_participants",
    "trigger": "hrm_training_guard",
    "function": "hrm_training_guard"
  },
  {
    "table": "hrm_training_feedback",
    "trigger": "hrm_training_guard",
    "function": "hrm_training_guard"
  },
  {
    "table": "hrm_comp_cycles",
    "trigger": "preserve_historical_compensation_cycle",
    "function": "preserve_historical_compensation_cycle"
  },
  {
    "table": "payroll_period_openings",
    "trigger": "payroll_period_opening_guard",
    "function": "payroll_period_opening_guard"
  },
  {
    "table": "payroll_opening_balances",
    "trigger": "payroll_annual_period_bounds_guard",
    "function": "payroll_annual_period_bounds_guard"
  },
  {
    "table": "payroll_opening_program_bases",
    "trigger": "payroll_program_period_bounds_fence",
    "function": "payroll_program_period_bounds_guard"
  },
  {
    "table": "payroll_opening_program_bases",
    "trigger": "payroll_program_period_bounds_guard",
    "function": "payroll_program_period_bounds_guard"
  },
  {
    "table": "org_business_calendars",
    "trigger": "org_business_calendars_history_guard",
    "function": "org_business_calendars_history_guard"
  },
  {
    "table": "aging_bucket_policies",
    "trigger": "aging_bucket_policies_history_guard",
    "function": "aging_bucket_policies_history_guard"
  },
  {
    "table": "payroll_employee_employer_assignments",
    "trigger": "payroll_employee_employer_assignment_guard",
    "function": "payroll_employee_employer_assignment_guard"
  },
  {
    "table": "hrm_benefit_transaction_policies",
    "trigger": "benefit_transaction_rule_guard",
    "function": "benefit_transaction_rule_guard"
  },
  {
    "table": "hrm_benefit_transaction_policies",
    "trigger": "benefit_transaction_rule_audit",
    "function": "benefit_transaction_rule_audit"
  },
  {
    "table": "hrm_benefit_transaction_items",
    "trigger": "benefit_transaction_rule_guard",
    "function": "benefit_transaction_rule_guard"
  },
  {
    "table": "hrm_benefit_transaction_items",
    "trigger": "benefit_transaction_rule_audit",
    "function": "benefit_transaction_rule_audit"
  },
  {
    "table": "hrm_benefit_transaction_positions",
    "trigger": "benefit_transaction_rule_guard",
    "function": "benefit_transaction_rule_guard"
  },
  {
    "table": "hrm_benefit_transaction_positions",
    "trigger": "benefit_transaction_rule_audit",
    "function": "benefit_transaction_rule_audit"
  },
  {
    "table": "hrm_benefit_transaction_responsibilities",
    "trigger": "benefit_transaction_rule_guard",
    "function": "benefit_transaction_rule_guard"
  },
  {
    "table": "hrm_benefit_transaction_responsibilities",
    "trigger": "benefit_transaction_rule_audit",
    "function": "benefit_transaction_rule_audit"
  },
  {
    "table": "hrm_benefit_transaction_limits",
    "trigger": "benefit_transaction_rule_guard",
    "function": "benefit_transaction_rule_guard"
  },
  {
    "table": "hrm_benefit_transaction_limits",
    "trigger": "benefit_transaction_rule_audit",
    "function": "benefit_transaction_rule_audit"
  },
  {
    "table": "project_budget_baselines",
    "trigger": "project_budget_baselines_evidence_guard",
    "function": "project_delivery_evidence_guard"
  },
  {
    "table": "project_budget_baseline_lines",
    "trigger": "project_budget_baseline_lines_evidence_guard",
    "function": "project_delivery_evidence_guard"
  },
  {
    "table": "project_forecasts",
    "trigger": "project_forecasts_evidence_guard",
    "function": "project_delivery_evidence_guard"
  },
  {
    "table": "project_progress_entries",
    "trigger": "project_progress_entries_evidence_guard",
    "function": "project_delivery_evidence_guard"
  },
  {
    "table": "project_revenue_accruals",
    "trigger": "project_revenue_accruals_evidence_guard",
    "function": "project_delivery_evidence_guard"
  },
  {
    "table": "internal_billing_rules",
    "trigger": "internal_billing_rules_history_guard",
    "function": "internal_billing_rules_history_guard"
  },
  {
    "table": "schedule_boards",
    "trigger": "schedule_boards_guard",
    "function": "schedule_boards_guard"
  },
  {
    "table": "schedule_codes",
    "trigger": "schedule_codes_guard",
    "function": "schedule_codes_guard"
  },
  {
    "table": "schedule_entries",
    "trigger": "schedule_entries_guard",
    "function": "schedule_entries_guard"
  },
  {
    "table": "schedule_source_records",
    "trigger": "schedule_source_records_guard",
    "function": "schedule_source_records_guard"
  },
  {
    "table": "schedule_distributions",
    "trigger": "schedule_distributions_snapshot_guard",
    "function": "schedule_distribution_snapshot_guard"
  },
  {
    "table": "schedule_distribution_recipients",
    "trigger": "schedule_distribution_recipients_snapshot_guard",
    "function": "schedule_distribution_snapshot_guard"
  },
  {
    "table": "einvoice_documents",
    "trigger": "einvoice_documents_immutable",
    "function": "einvoice_documents_immutable"
  },
  {
    "table": "withholding_deductions",
    "trigger": "withholding_deductions_guard",
    "function": "withholding_deductions_guard"
  },
  {
    "table": "withholding_returns",
    "trigger": "withholding_returns_guard",
    "function": "withholding_returns_guard"
  },
  {
    "table": "payroll_holiday_obligations",
    "trigger": "payroll_holiday_obligation_guard",
    "function": "payroll_holiday_obligation_guard"
  },
  {
    "table": "payroll_holiday_occurrences",
    "trigger": "payroll_holiday_obligation_guard",
    "function": "payroll_holiday_obligation_guard"
  },
  {
    "table": "pay_run_holiday_allocations",
    "trigger": "payroll_holiday_allocation_guard",
    "function": "payroll_holiday_allocation_guard"
  },
  {
    "table": "pay_run_holiday_allocations",
    "trigger": "payroll_holiday_allocation_audit",
    "function": "payroll_holiday_allocation_audit"
  },
  {
    "table": "consignment_stock",
    "trigger": "consignment_position_guard",
    "function": "consignment_position_guard"
  },
  {
    "table": "consignment_events",
    "trigger": "consignment_event_immutable",
    "function": "consignment_event_immutable"
  },
  {
    "table": "inventory_count_policies",
    "trigger": "inventory_count_policy_history_guard",
    "function": "inventory_count_policy_history_guard"
  },
  {
    "table": "stock_count_lines",
    "trigger": "inventory_serial_count_history_guard",
    "function": "inventory_serial_count_history_guard"
  },
  {
    "table": "warehouse_scan_events",
    "trigger": "warehouse_scan_history",
    "function": "warehouse_execution_history_guard"
  },
  {
    "table": "pick_waves",
    "trigger": "pick_wave_history",
    "function": "warehouse_execution_history_guard"
  },
  {
    "table": "pick_wave_members",
    "trigger": "pick_wave_member_history",
    "function": "warehouse_execution_history_guard"
  },
  {
    "table": "handling_unit_moves",
    "trigger": "handling_unit_move_history",
    "function": "warehouse_execution_history_guard"
  },
  {
    "table": "warehouse_execution_tasks",
    "trigger": "warehouse_execution_task_guard",
    "function": "warehouse_execution_task_guard"
  },
  {
    "table": "pick_execution_lines",
    "trigger": "pick_execution_history_guard",
    "function": "pick_execution_history_guard"
  },
  {
    "table": "handling_units",
    "trigger": "handling_unit_lifecycle",
    "function": "handling_unit_lifecycle_guard"
  },
  {
    "table": "handling_unit_contents",
    "trigger": "handling_unit_content_history",
    "function": "handling_unit_content_history_guard"
  }
] as const;

export const TENANT_RETIREMENT_AUTHORITY_FUNCTIONS = [
  {
    "name": "openbooks_retirement_trusted_login",
    "sha256": "df5c7924dedd26409822800647c426cb205b2c271fe386e04c3ca932b0ac4332",
    "returns": "boolean",
    "language": "sql",
    "volatility": "s",
    "config": [
      "search_path=pg_catalog"
    ]
  },
  {
    "name": "openbooks_retirement_row_org",
    "sha256": "3d4113d4349185656b95ef222a8c67db0c3b7bf57e5f9df172a6005591d5d242",
    "returns": "uuid",
    "language": "plpgsql",
    "volatility": "s",
    "config": [
      "search_path=pg_catalog,public"
    ]
  },
  {
    "name": "openbooks_tenant_retirement_delete_allowed",
    "sha256": "2dad6bd5d7f73abbb173544c76824bcfe8b9042f728ff43d2a2b40b691b7d65b",
    "returns": "boolean",
    "language": "sql",
    "volatility": "s",
    "config": [
      "search_path=pg_catalog,public"
    ]
  },
  {
    "name": "openbooks_assert_tenant_available",
    "sha256": "9c1d7eb37304059149c86787a0bfcf497a7f2bf15a09b16c567c89ccb11fc1d3",
    "returns": "void",
    "language": "plpgsql",
    "volatility": "v",
    "config": [
      "search_path=pg_catalog,public"
    ]
  },
  {
    "name": "openbooks_tenant_retirement_fence",
    "sha256": "dcfa06636392cd01c8c6d68c29fb22d01698bc9aac41729fa6a563bdec50ba4d",
    "returns": "trigger",
    "language": "plpgsql",
    "volatility": "v",
    "config": [
      "search_path=pg_catalog,public"
    ]
  },
  {
    "name": "openbooks_tenant_retirement_new_org",
    "sha256": "2903d1c056e3cbd05b5eeea0932bc23cdbad66c0cb9f6fabb1f24167dc05f755",
    "returns": "trigger",
    "language": "plpgsql",
    "volatility": "v",
    "config": [
      "search_path=pg_catalog,public"
    ]
  },
  {
    "name": "openbooks_retirement_catalog_digest",
    "sha256": "14448f2621c6a3a166176b73d25696f3976f4ee0a33bd81917a74af7b533da96",
    "returns": "text",
    "language": "sql",
    "volatility": "s",
    "config": [
      "search_path=pg_catalog,public"
    ]
  },
  {
    "name": "openbooks_retirement_register",
    "sha256": "f2566ed4715b8f239e6cb98c5815787938d99805b8d403ed1ca06ce406b3ea32",
    "returns": "uuid",
    "language": "plpgsql",
    "volatility": "v",
    "config": [
      "search_path=pg_catalog,public"
    ]
  },
  {
    "name": "openbooks_retirement_begin",
    "sha256": "1654948150630ad9b65841929c064a90402a6ad7fd0466bc6b5826f15a5f6926",
    "returns": "boolean",
    "language": "plpgsql",
    "volatility": "v",
    "config": [
      "search_path=pg_catalog,public"
    ]
  },
  {
    "name": "openbooks_retirement_storage",
    "sha256": "ce917d5ea1383f5715d51c21788ce2cb3d81ac1fd5dc4036f52c3c3e5ef65e18",
    "returns": "void",
    "language": "plpgsql",
    "volatility": "v",
    "config": [
      "search_path=pg_catalog,public"
    ]
  },
  {
    "name": "openbooks_retirement_finish",
    "sha256": "99ec1e07719afef11fc0b0cd2e0e01b5b90fc08812b2b0a758a82e39b0cf2919",
    "returns": "void",
    "language": "plpgsql",
    "volatility": "v",
    "config": [
      "search_path=pg_catalog,public"
    ]
  },
  {
    "name": "openbooks_retirement_status",
    "sha256": "dc968419eebd91196d3498295db388cbab6ad45ba09a59d1e80876c8d7ff53e7",
    "returns": "jsonb",
    "language": "plpgsql",
    "volatility": "v",
    "config": [
      "search_path=pg_catalog,public"
    ]
  },
  {
    "name": "openbooks_retirement_failure",
    "sha256": "6bfe3356d9785bf45479824b4979cdc386b40e6f0e1bebd9c0072da8c9808f21",
    "returns": "void",
    "language": "plpgsql",
    "volatility": "v",
    "config": [
      "search_path=pg_catalog,public"
    ]
  },
  {
    "name": "openbooks_retirement_release",
    "sha256": "60004ae7e76b8f641d21505b947627a958530fff9a0cb795b3eb4bdea3f0d377",
    "returns": "void",
    "language": "plpgsql",
    "volatility": "v",
    "config": [
      "search_path=pg_catalog,public"
    ]
  }
] as const;
