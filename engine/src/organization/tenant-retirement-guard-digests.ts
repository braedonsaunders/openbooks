/** Published DELETE guard digests; unknown or altered live guards refuse retirement. */
export const TENANT_RETIREMENT_GUARDS = [
  {
    name: "source_retired_time_guard",
    sha256: "099bccbab84f82ad200433a9484f655fee59351aa158afdaa69eae2650ed0578",
  },
  {
    name: "depreciation_source_authority_guard",
    sha256: "63fdeb6a8c7461daabb24fb344e4b2b246700cbceb3baf581698f7a6bbc54d80",
  },
  {
    name: "calibration_entry_published_guard",
    sha256: "a8d128e484d16f9f16a462afef52b325e2b541bbdf8a000162f7358daf0225f4",
  },
  {
    name: "subcontract_change_pending_terms_guard",
    sha256: "442fa77c5ad1297680bbc4e6f02b434af0b8f8fb9b1c43909aff970ad866f145",
  },
  {
    name: "native_command_pending_terms_guard",
    sha256: "5c766763063e1935610465d836d40559cfdfcb4c38aa80a982f8e98ce037b7d1",
  },
  {
    name: "flow_submission_receipt_guard",
    sha256: "21883dd58d659b5486efa7b68a97869b45cf93df0a9eb416a2a53d80e207376a",
  },
  {
    name: "payroll_roe_separation_basis_reference_guard",
    sha256: "c9336b7c7bf3a33b660ac3f522ffa13a738107f9a523edb6431334ddb45e63de",
  },
  {
    name: "time_type_financial_semantics_guard",
    sha256: "41a110e2f33bc387a21d7791e792fa310e371cce9deaf0e6d34c4a6b8513fd27",
  },
  {
    name: "payroll_roe_used_exclusion_guard",
    sha256: "bd27324c014060afb7ffac2995714db4036126dd5982c774fb4f8d47ff055790",
  },
  {
    name: "payroll_roe_issued_event_source_guard",
    sha256: "4836e1aa77f7b2bd3cfdc246c259f5cb2824410a539178a2d54ed0459de7f614",
  },
  {
    name: "payroll_roe_subsequent_service_source_guard",
    sha256: "6f7582c5491c30d83b678de1aadfd7c4a59066405d7ce83193d4378805be98d8",
  },
  {
    name: "payroll_opening_employer_authority_guard",
    sha256: "cfd0fcc78d530af887f87f345a78b17c4b219a86a201b6b1ab58d50fa3bc28df",
  },
  {
    name: "payroll_opening_qualified_source_guard",
    sha256: "0df2ebc963b29e050b286169ed8564a41214a3fd1de7d8163bae9e1244967c1f",
  },
  {
    name: "payroll_roe_reporting_evidence_guard",
    sha256: "cf0d7d140805d19a59b92303f1b96a4114101d62cda002595befbcac9814799d",
  },
  {
    name: "payroll_roe_separation_facts_guard",
    sha256: "882dcdb0f9cfceb172386f4947e7153e4c15c284150455cd796e328624fc819e",
  },
  {
    name: "rebate_agreement_guard",
    sha256: "70eda52193664d3f548291608a4828e9780c97194df5a4ed4fa8d643080d6efe",
  },
  {
    name: "rebate_claim_guard",
    sha256: "5dd3382123d65acba2da92186e5ab090c4ca95796c92ace37c65c0651afcfbdd",
  },
  {
    name: "rebate_fact_immutable",
    sha256: "19983175d3685537c95d634c788b82991cbeef1c035dce74db83ef0018bbb427",
  },
  {
    name: "renewal_policy_guard",
    sha256: "c0fa72318a1fb9dc70209e8afbab886eebd84d23dcd5acca026b3b8c0ac190b3",
  },
  {
    name: "fair_value_used_policy_guard",
    sha256: "51db1038c2fcf434307a45a24e3164eafdbdbb10dc9455349da07ebe1afe3438",
  },
  {
    name: "recognition_control_immutable",
    sha256: "01717f9b0b6f6ff5b890cc0e0a4fd88d0942d26d608623af7da414c5309a8696",
  },
  {
    name: "journal_reversal_instruction_guard",
    sha256: "d57042081fc24caa21b4640f5ac3a6c6649fcfb191bad2e9ba5e4df4314569ef",
  },
  {
    name: "intercompany_fulfillment_charge_immutable",
    sha256: "04bf84b2d384b0e4e5654090ad89c3bb4e9f438f833b62d705fb358703409276",
  },
  {
    name: "intercompany_transaction_pair_guard",
    sha256: "bd11595bf3c9769f72b20c8f314845d360847131038e224d1648e5d0ddb15e03",
  },
  {
    name: "intercompany_transfer_pricing_policy_guard",
    sha256: "490da8c21f22969b197f9f998d2097b5078a0e4c27e200cc0d3483103a41d82e",
  },
  {
    name: "intercompany_fund_transfer_guard",
    sha256: "3e275abb17104e72ef36cdf07ff9c708506b5dd7f0f97ff1a6795ef94331b6b5",
  },
  {
    name: "intercompany_netting_line_guard",
    sha256: "c42af7c8e3b66f332312d70cf6897eaf9a43ceea7e7477d6901e9017f66308ed",
  },
  {
    name: "intercompany_netting_run_guard",
    sha256: "e3d7561f399608bfce6f333f572b6b5fb979e1768dc6315cc8fe829f5e2e3a7c",
  },
  {
    name: "account_merge_immutable",
    sha256: "90dc884d5ae0fbb80f4a5ba330a80107bd9f201c2b659298c438d25f132469e2",
  },
  {
    name: "hrm_benefit_program_revision_immutable",
    sha256: "0a27548afa8b82c92b1fb9a423cf7967ebb956fda461c2ede441357cc28ed439",
  },
  {
    name: "field_ticket_source_certification_guard",
    sha256: "24f5e61335086799a9fd4692c4fee132be9243fbaa34279cc02e0217d012c891",
  },
  {
    name: "fx_revaluation_rate_evidence_guard",
    sha256: "2bb84f39705198d6677b59efa8158e59ab07a91a6fc49131705f96cfa013e984",
  },
  {
    name: "payroll_ca_opening_reporting_authority_guard",
    sha256: "2ebf6495156b721da3f3b7255ae23127de02dc8e57424d0a66e98a23d2fe7377",
  },
  {
    name: "payroll_ca_opening_reporting_allocation_guard",
    sha256: "3cc2f9750422a396513a7b7db8b72fe5f9830fd5976205aac6ca517f1b245e63",
  },
  {
    name: "payroll_ca_opening_reporting_account_guard",
    sha256: "ba016f1c8294c60c29c9e2f19fcf9024d9f04312e98929f3fd75d40dd007356f",
  },
  {
    name: "payroll_us_filing_account_lineage_guard",
    sha256: "beae5e1216675b30498fc074b62a2ba8dbf181f37b09301d98faf27db682b797",
  },
  {
    name: "payroll_opening_levy_opening_source_guard",
    sha256: "4b9d0f5a415dd3f872fde20b13a6a7692cdabd18999f940f927f714f54c9eb10",
  },
  {
    name: "payroll_opening_levy_source_allocation_guard",
    sha256: "0dae5ebe92eb319027166ab52aa57d583c22ff2c7f20c65b2718abe06b00f47d",
  },
  {
    name: "payroll_opening_levy_source_authority_guard",
    sha256: "56d569fa9dd247bb08d2b27bf7f8a94a52e943781943585b9250336e16a43878",
  },
  {
    name: "historical_translation_basis_guard",
    sha256: "7d7ca87034fe986f1781c179c7a92d55546703ba9b1138be90cd3f6418075ef0",
  },
  {
    name: "historical_translation_layer_guard",
    sha256: "35877a46a3e2069bb7c79ed45257bf60a9580560c5fa020fc40af02392d10cfa",
  },
  {
    name: "historical_translation_source_retention",
    sha256: "fd6e7437fa4e4bce97e809839cea83e56c165995ccb6a077af85112243b05786",
  },
  {
    name: "historical_translation_file_retention",
    sha256: "ee8035d28335d3c8c27506cbcbbaa8efae0e3151dd32f0b5a00885590ded292b",
  },
  {
    name: "account_group_member_scope_guard",
    sha256: "8a84115166d66987d60c431cae362f4627e948b8acf154c95ebe330cdf001b70",
  },
  {
    name: "accounting_book_account_map_guard",
    sha256: "1441263ecb10f36afe08b60ae0c5b5477f0fa9658bb9ec6c00c76ac6ec42b628",
  },
  {
    name: "accounting_book_currency_guard",
    sha256: "8e9382dc8a72bf44a64cd5a175655648c6ea43da57a4e37e75c7d5591a75e3a8",
  },
  {
    name: "accounting_book_replication_run_immutable",
    sha256: "2602a805edc008997535fa1a1c461a06eaa7e09e39b6520df3750acb773f7c15",
  },
  {
    name: "aging_bucket_policies_history_guard",
    sha256: "1946848eedc0d0f54a6d193d0a41d4edfa69518fdcf3cc161db2471948b81e73",
  },
  {
    name: "ai_decisions_refuse_update",
    sha256: "c9374b3f6a7765ef446e4f1066fa0dac74454e7fa77c0bae395fc6f0b3755c7e",
  },
  {
    name: "allocation_rule_target_guard",
    sha256: "a76d7247d768665eb76f5455831eaaf96cda4045865a3d571681ba645a564b81",
  },
  {
    name: "application_evidence_guard",
    sha256: "c16fedc72f2ff8b33001354bf4855051439877b3989348ba6ebb39b000775804",
  },
  {
    name: "assembly_disassembly_immutable",
    sha256: "1b4a0e915d028f4b4c92fb9b2315f900dce5d16dde89a81744e2e03434381a52",
  },
  {
    name: "asset_basis_change_guard",
    sha256: "17b8aaab04b84402f040d637ce2f5aaee602ea0a3bcaebdc0998d9ba0916398f",
  },
  {
    name: "asset_event_append_only_guard",
    sha256: "331a4100ee55d054476ff0f9fecfb2322c0159b27e725bc10eb0aa91110dbaff",
  },
  {
    name: "asset_transfer_history_guard",
    sha256: "38879e83f23afe9d0cdb1cb081cf10bb6da5fea6f8a15823edadfaddb1d8b16b",
  },
  {
    name: "asset_transfer_measurement_guard",
    sha256: "c174dfd679cd370891b96ca7f95f486396606f6bb1b3b6c5e8e3f14225563ff5",
  },
  {
    name: "audit_log_append_only_guard",
    sha256: "4d4625231d852dad26b006891b9400173ec28c4afac3c5a601bbff3e41868c4c",
  },
  {
    name: "benefit_catalog_identity_guard",
    sha256: "d38bdaaeaa6622cd6e341e352b738865f346bf38192d86abb62a03409cd67248",
  },
  {
    name: "benefit_recovery_source_guard",
    sha256: "385b73e95f2a0a793a62cdd1d005940cfda17d9995f162fce06d2ac95d4887a5",
  },
  {
    name: "benefit_recurring_audit",
    sha256: "2bb2d1b15b48142adeb8a29e3711dad3e0c00165998179f355cb017710ebd266",
  },
  {
    name: "benefit_recurring_configuration_lock",
    sha256: "51537522674abf1bb665627205e826da5560552cfee5d42b9d4cef0878307bea",
  },
  {
    name: "benefit_recurring_history_guard",
    sha256: "22a9285f207dbfaaa3d7c4656e789a176becf387f5d00bc59f0daf6a911af4d9",
  },
  {
    name: "benefit_transaction_rule_audit",
    sha256: "fcb03068f7bbefba435a45bb245cd8aaf46040eb81ab4651b92f37dcaa03c0f0",
  },
  {
    name: "benefit_transaction_rule_guard",
    sha256: "ff8c88f12b663e94a7a416d12991d5466a3f5f6e12aec4abfeac3e456ad1c467",
  },
  {
    name: "billing_request_field_ticket_guard",
    sha256: "c6c7b606e07b4304b3e1c809f0e59a332943a05178a880bee95e1f5be65b59fb",
  },
  {
    name: "change_set_items_lifecycle_guard",
    sha256: "a777f1f80e050826e743804bc67570fce1a1439815aaa3bb9c1c342b13e9c75d",
  },
  {
    name: "close_append_only_guard",
    sha256: "48e2596392cb0a66511cbac3b147ff072a28b82b55b0b4cc00fb02f6a8fb4e65",
  },
  {
    name: "consignment_event_immutable",
    sha256: "c92cfd2fac4ffc1ddcec3651bb6e571d7cab454659bc1a016ddac01cef27c866",
  },
  {
    name: "consignment_position_guard",
    sha256: "4100fb08bf8f48fd849763e85842413c836e2658cf8ef4e75c7c8e88108c22e3",
  },
  {
    name: "contract_cost_amortization_immutable",
    sha256: "4e6f370f61abd4c4bbe617e897d6a537768650f72204544f11ce3fbdfca1de8d",
  },
  {
    name: "control_loss_history_guard",
    sha256: "5266c018353fdf9adc114990f626d4529ed8161d0015b1dbc957296563eacb87",
  },
  {
    name: "control_loss_source_guard",
    sha256: "b7730e245e30e208584e5d9024d7b96a4bcb162cf207e19123844021ffff3211",
  },
  {
    name: "data_transfer_evidence_guard",
    sha256: "9ca4a5ce34e6c6da2654695f47816a8a35d4051f80701edc8d80e59d52406c9d",
  },
  {
    name: "depreciation_book_policy_history_guard",
    sha256: "7892ecbd58cd9d812d54be62b0860ae62dcd9293bb790013fbe6b39d415e0f68",
  },
  {
    name: "depreciation_evidence_attachment_guard",
    sha256: "fd91428a38d7d5a08823ea70ba1b291842e40362e3e4165cf471e27c7f651617",
  },
  {
    name: "depreciation_non_gl_recognition_guard",
    sha256: "98f0f2ebeb8fd7f04da8aa26762a39cb2f26472011149734c7c1004da843a759",
  },
  {
    name: "document_correction_lineage_guard",
    sha256: "fe596d8052e38f65f576e50c8db7a246dd4aa767003839d4e131f7f1f283b11c",
  },
  {
    name: "document_line_immutability_guard",
    sha256: "9e5f4e7b5262ead439abf1da76275c0f436df16b8ae16697f109446cd9c4ac24",
  },
  {
    name: "document_line_tax_component_guard",
    sha256: "a1543f16ab602143fb032b7e7f9ff28dd0be0432f450d0ea0c6d39e486bbe1d4",
  },
  {
    name: "document_lines_total_line_refresh",
    sha256: "04bd8dbe66b8d765b18e613c670d360bc0e88bdb995070ef30705ccd2801c683",
  },
  {
    name: "document_lines_total_line_tieout",
    sha256: "8e9476b24463f9311891f64627d3c72ad2021f462f51c91c5f8357bc40682130",
  },
  {
    name: "document_supply_evidence_guard",
    sha256: "d0fe78f258761f3b0a5c75a2292299ac4358b51330966cfa3982f1f6bb16ae7d",
  },
  {
    name: "document_tender_lifecycle_guard",
    sha256: "ae7badc6a311b1bd9a9df3dde8d74b33e7c5622ba63561c38458dc133bee25c2",
  },
  {
    name: "drop_ship_allocation_guard",
    sha256: "0ccbb1be53311a0a7cf9d06e2f07b3b3e9cd86c2cdf3a06e98d6c76da4cbe465",
  },
  {
    name: "dunning_log_guard",
    sha256: "d75214276f419d5452ae74884ee0adceef5e22c62f48547fb90a62480c1ae688",
  },
  {
    name: "einvoice_documents_immutable",
    sha256: "9221b0026514f83adc4ddc637a1ba841972182d5c712c95c48a5fab46c255ea4",
  },
  {
    name: "employment_assignment_versions_closure_guard",
    sha256: "ccf6e532f507028a49487406abcd9372e252ea98a6a6bebdeff0ecce06c11f8f",
  },
  {
    name: "employment_changes_immutable_guard",
    sha256: "c0ab0963e6527424c2a5bdcf0200cd6fa53aec86dc1b4b9624be7d54a160b0dc",
  },
  {
    name: "enforce_deleted_role_assignment",
    sha256: "c19c4d528f0385284be86a5551b4bcd1b5b38551d5ba07a23f77305df033d3dd",
  },
  {
    name: "enforce_payment_instruction_posting_claim",
    sha256: "9e575165e56acae28f6ee4c6860bf3d969804145aebab39943a351bd4c6c1b9d",
  },
  {
    name: "entitlement_ledger_append_only_guard",
    sha256: "dfd652399b54d27996e3c349ba223167950cdbd8a7304e2b3c31ca898552914c",
  },
  {
    name: "expense_amortization_event_guard",
    sha256: "d104ac3ef1bde1af08611cfbbcbec156b8f29226b052447e4ff8f01ba039f2b6",
  },
  {
    name: "expense_amortization_line_guard",
    sha256: "0e7d6580116286f0e2bb32b4899cf3f7b96c0577f358413d51f2d681c4616160",
  },
  {
    name: "expense_amortization_schedule_guard",
    sha256: "783345d0c9a8efd5648dc2615e84a9f3177b20b378be3375e412e91f76d13301",
  },
  {
    name: "field_ticket_labor_line_immutable_guard",
    sha256: "63df9eea369f3b28d3d83cd9634dba76bedba7bb65a1e471f25320fbfbb734d6",
  },
  {
    name: "field_ticket_labor_snapshot_retention_guard",
    sha256: "a33480432dcb45198c495d4a7c80cc49de61d6cb8188cb43660519845ef76d17",
  },
  {
    name: "field_ticket_signature_immutable_guard",
    sha256: "83be40a487799d8acba62604cc7aff69848407a9a621a7c43007ab366af4d89f",
  },
  {
    name: "field_ticket_signature_request_guard",
    sha256: "28a8ef5f383204287bdfb7af9d8dfa53d6d67edc1c0721d86387237e30f76c2a",
  },
  {
    name: "financial_change_guard",
    sha256: "7f87f9711fe93340e4ac50c108e8d13bc9a184b8ffc919274d2be656db2a5b99",
  },
  {
    name: "equity_record_immutable",
    sha256: "6cfb14a1eb3c1332895e01e9f9c8ded1e880b07d1395abdc7cf7113d904bd9cc",
  },
  {
    name: "equity_action_request_guard",
    sha256: "a69f2e94189a414ac3ed1928979bc3e070fbdc52069006a3726f07106e7c5f39",
  },
  {
    name: "financial_policy_version_immutable",
    sha256: "f1817fdfc45950978c79b5f91e43a65fcc897189ddb6c5a4a6d25d484d08690a",
  },
  {
    name: "fulfillment_documents_guard",
    sha256: "944300da429fd422e03b462d0560f31c13ec0d035bc490c7673fb2c87b7842e1",
  },
  {
    name: "fulfillment_lines_guard",
    sha256: "a7d34ce55cb1dc13d08a42679a32ab41aa3f47cfc4511bb3f6622110c604d006",
  },
  {
    name: "fx_rate_age_policy_history_guard",
    sha256: "b14cbc28e1a1e44b10569eaaf71ee71b8ffd738e8b7ff4c42800044e4f19bb62",
  },
  {
    name: "goods_tax_registration_history_guard",
    sha256: "6fedb5a2637c1c3ab2003a4f37b51d9762b73fa6ad517664e8ae61be75314687",
  },
  {
    name: "goods_tax_snapshot_guard",
    sha256: "0fe81bd84f2076e84c097a27702bd94c374e262444fc5835c8bfcd7219318e07",
  },
  {
    name: "handling_unit_content_history_guard",
    sha256: "5012aac6c027f34053eeebb11856a15fc51f86dcb67eaaf10cd0f1c85355ab1e",
  },
  {
    name: "handling_unit_lifecycle_guard",
    sha256: "40dda5cb006fce4a6f8d80483a0b8a54a3768e838af403fa6d8aef0db7d809a2",
  },
  {
    name: "hrm_absence_no_delete",
    sha256: "4dfa710661af5cd1da8964833ca0642d678a753fe56d669399368db1d398fa9c",
  },
  {
    name: "hrm_allowance_payroll_input_no_delete",
    sha256: "575691b4d0cf2f55bb6887c8cf33f2d177ce5f6413489756d1f5b858d3546dc5",
  },
  {
    name: "hrm_application_events_immutable",
    sha256: "d2c14ce1bff8ad9ee2a65a6704c0ad6c5eb8232a60cda187bae9d4b3ad9a6b97",
  },
  {
    name: "hrm_benefit_award_event_no_delete",
    sha256: "8b7aeef6376ee219518168000059b435deb3281ead8e8b1b11f20e969a817a40",
  },
  {
    name: "hrm_benefit_award_no_delete",
    sha256: "5810264f049b00298632357c1834561af76a24d05f7c40b4baef26da1f169384",
  },
  {
    name: "hrm_benefit_enrollment_no_delete",
    sha256: "898504f2380025f85a19e72d13690795ad5ef2fb47c02628de389d7b1598c053",
  },
  {
    name: "hrm_benefit_event_no_delete",
    sha256: "df7f94b59fb24b2714d4549cae807fd3e4ceb8c9ecbe3177422b86c3682ba024",
  },
  {
    name: "hrm_benefit_payroll_input_no_delete",
    sha256: "a5db92e0ab94edaed339b4990fe5aa0e5cc7094603e0d61df843da6b7624e547",
  },
  {
    name: "hrm_benefit_program_no_delete",
    sha256: "9e46174eeceb6a3b153fcc4a30cb928d9ebea95972953909947e6bd9e5a013b2",
  },
  {
    name: "hrm_calibration_event_no_delete",
    sha256: "a2ec6cee29ac5151871c4209b95ef3f3d11f3862e97d354e8be535c06d0debd7",
  },
  {
    name: "hrm_checklist_publication_guard",
    sha256: "8c44f917a1530190e0d7b7efa33f3dbc896953590efe197762cd40b4651f4ac8",
  },
  {
    name: "hrm_checklist_version_immutable",
    sha256: "ed13933eb3d11c55eebbfbb9398a11472f7ad948a285c6a26ef6236c4ef7395f",
  },
  {
    name: "hrm_compensation_history_guard",
    sha256: "63cd9e6c47db7a2d8a6af794478f6787ed0a83c69ade85797c975cecbd8d0354",
  },
  {
    name: "hrm_compensation_plans_guard",
    sha256: "3f8522705d542f9b28188734d11353d6d989e1177a8f1997f1a07e7cb6e6b468",
  },
  {
    name: "hrm_compliance_findings_no_delete",
    sha256: "4dc32dd4379c9f03f7c93254fac73a91a40e32fae109c72e31a1d007dea503e7",
  },
  {
    name: "hrm_documents_history_guard",
    sha256: "28a5dfc702d46939120d9225fc966d40e419dee1e7c1999654cdd41ac5444a6a",
  },
  {
    name: "hrm_employment_change_request_no_delete",
    sha256: "979e5d88b23a1017fb86676a898b1e116dc4c1a810edf159ded6ddd6c5dab6df",
  },
  {
    name: "hrm_exit_record_event_no_delete",
    sha256: "aa9f109f1f50248d30ce3c37c9c02453b8f9dd1c307b0f3fdeddd5e82bffc817",
  },
  {
    name: "hrm_exit_record_no_delete",
    sha256: "3895558d475803dcb6351fb5e5a7ea29320b4adb902b637cd92bc83b433579c9",
  },
  {
    name: "hrm_feedback_no_delete",
    sha256: "58ad0c39786c90e926766ca399c6fab116da445cdad4da79cc4f3dbce3257f0d",
  },
  {
    name: "hrm_goal_update_no_delete",
    sha256: "8f022cea76f3bff5552aeeaa9474ad5acfc0e1179383df3f6cc0f8565a479ab7",
  },
  {
    name: "hrm_leave_request_no_delete",
    sha256: "74717c499fee9a6e1f48e2eca075cfad18ad12da87643fa3b251e9e0f38ed14a",
  },
  {
    name: "hrm_payroll_input_no_delete",
    sha256: "3824ddaddadf15c555cb0b19ef413694ad55f9bdb16a6e14b7d38c28d84587d6",
  },
  {
    name: "hrm_pipeline_template_no_delete",
    sha256: "7857864905d2b9a15c1698384cd8c50ae6066b325a84f138175bfe1cf315ab48",
  },
  {
    name: "hrm_process_steps_history_guard",
    sha256: "cbaaec0dfcca4adf4ae5d4114ca2f7290c6deb063b342cd3e1b076164ebf0e5f",
  },
  {
    name: "hrm_process_template_no_delete",
    sha256: "ab1672961357916af998d83b9989aa0e8734ccf52e8e2554fba48fa7be9aa14d",
  },
  {
    name: "hrm_processes_history_guard",
    sha256: "79dd051b031cc6cfa5cb36ed9b9b5b7e8314b4177373cc5cd465d427e98cb50d",
  },
  {
    name: "hrm_qualification_events_no_delete",
    sha256: "209482c3cafcc73094e7a51a528e6d7a5710fa6281491f8b5b12e5f766d3e91a",
  },
  {
    name: "hrm_recruiting_depth_append_only",
    sha256: "9098c4f6d31ef1f36e155026c0e283626f44dc666c1c3c0ca2cebc39025b4858",
  },
  {
    name: "hrm_recruiting_history_guard",
    sha256: "f0ec510aba198e45f488f2c15dcfdeb6a86825c2c47676d782ce92b04975311d",
  },
  {
    name: "hrm_review_event_no_delete",
    sha256: "e680cffa04a450aa4597df712e4c86c4af3a18bd0e98bb2586629449380a6ef3",
  },
  {
    name: "hrm_review_no_delete",
    sha256: "1ce32ed013636689608f888a748ea3cfca747386c3fd05875f0484942f6c22fc",
  },
  {
    name: "hrm_review_template_no_delete",
    sha256: "d2ac564e904a84d1cbfb8edc8a41858626061bbdb33418592f9c4001bf7a2ba8",
  },
  {
    name: "hrm_scorecard_submitted_immutable",
    sha256: "c8ca655ef48f31c7dbf44d9a9e8a423b3a33054219200f78ea407a1e555fcdb9",
  },
  {
    name: "hrm_talent_review_no_delete",
    sha256: "0f064fd83cc7a260b89378aab3ce696e8a20459e3a0dfb9ab06bf11ef17cc876",
  },
  {
    name: "hrm_training_guard",
    sha256: "f0b7fd59034f266a1ce1c47bfafdd62db76d324fb4dd02abe263d8eaccd1e98c",
  },
  {
    name: "internal_billing_rules_history_guard",
    sha256: "315273f3d0a00b6e99d1d4520d1803acb54aa61537aab8ebfea48c01b41f5cee",
  },
  {
    name: "inv_move_guard",
    sha256: "48846fcf44671154f852786dbaa4546a609ebe430946d189eb54a23bbb4c6ab5",
  },
  {
    name: "inventory_count_policy_history_guard",
    sha256: "147c25b98af9a3bf6cf69572e493ff1f0b73f8c18d36c54eb7b8f3699c8b0bbb",
  },
  {
    name: "inventory_lot_identity_guard",
    sha256: "dfe6840b72217c786a1adbc395cfeff8c5145de889344961b951615695d48839",
  },
  {
    name: "inventory_provisional_immutable",
    sha256: "e5b8f44470441c5c2d3e9d4110ca813ec909443e6423c7170e068184cca1a65b",
  },
  {
    name: "inventory_serial_count_history_guard",
    sha256: "f6ddf2e298fe9fafac158622051e16063791094e6a2b42570b90dc833d1c9228",
  },
  {
    name: "inventory_serial_lifecycle_guard",
    sha256: "322f7963f1479042a2db00f86d6bbc21eedbca863b5df92a9716fde15789d340",
  },
  { name: "je_guard", sha256: "81264b8d4c0b65a49d18fcda3fc0c4c97a3964b5d12cabed457d4c01b0485190" },
  { name: "jl_guard", sha256: "7d99adf2194cdb727672a9cbc5b5b07cc6e75788422e678439b276191eb13b3f" },
  {
    name: "journal_lines_check_balanced_stmt_del",
    sha256: "afbb0489e6027291e8641f932d49f55cecc076dde2e2b9ce522773de385c02af",
  },
  {
    name: "journal_lines_check_fx_residual_stmt_del",
    sha256: "ba13b43ff230091b873a75938c1c5dbce82f2438fa12c9d78403a62d51d226f4",
  },
  {
    name: "landed_cost_allocation_guard",
    sha256: "ac034451984f9c956076f7488a5be2aa278522fb49429ea23cf06ff5e074d03d",
  },
  {
    name: "landed_cost_voucher_guard",
    sha256: "030348a94775ff4e27197991245ca1cb63d586cb116874027effb3b97833c1cb",
  },
  {
    name: "landed_cost_voucher_target_guard",
    sha256: "01b7005a5cb772deb0302368945eab9cba4865e787e5863a28b5fcc673b12828",
  },
  {
    name: "lease_agreement_revision_guard",
    sha256: "2982b4b6ba82c44a0bd5d020d3e2a5f45dcf2958d5334512e5e4356fca4210be",
  },
  {
    name: "lease_schedule_history_guard",
    sha256: "100716d7f7ec0b3343e3fea8ee2c0b83a060783207991e5b30a9d0081361c58e",
  },
  {
    name: "multibook_evidence_immutable",
    sha256: "57cfe6f0bffa374dcdb2958ae7cec3b0ec01c68b0e5ac31f54e3c8657d73bdd7",
  },
  {
    name: "net_investment_configuration_guard",
    sha256: "affe81c2ffcdd5ada496b24d196f30b9f774e73345d11a938837929539cff46d",
  },
  {
    name: "net_investment_evidence_guard",
    sha256: "21a55d2377f5c1c4cb79e0721b33ad9c0d60f1a077e491bf462ec85866d6573c",
  },
  {
    name: "nonprofit_frameworks_guard",
    sha256: "550502ce39c94e0a304aedfee5e0060f4270326518d180e5c03e29e8dd9ec49c",
  },
  {
    name: "openbooks_bank_statement_line_guard",
    sha256: "54b74c992874a580d5d2871f4944c41a3b54b018ee4b184c4eea84f4be0960da",
  },
  {
    name: "openbooks_gl_activity_entry",
    sha256: "26121381f7ace27324ac0dd861d82eb81ac28524ae046bc8f627109aee97189b",
  },
  {
    name: "openbooks_gl_activity_line",
    sha256: "777490764041ed8ec587b2068394957ef48be8596307a95b0f61d9cde83fad5c",
  },
  {
    name: "openbooks_guard_ap_capture_evidence",
    sha256: "db53ecd91cad0c5f3e4c4b9a6a09544db85cebacb91c7b7b422cb2e244fa9591",
  },
  {
    name: "openbooks_guard_ap_capture_source_blob",
    sha256: "cc8a8131769000981391399a2601667ca2268afeb7f9386bc863ad4f589cf690",
  },
  {
    name: "openbooks_guard_ap_capture_source_file",
    sha256: "f11e875cd30ea220309582fe531b50685fb5dfe2d7f308f78c47791726ec2dbc",
  },
  {
    name: "openbooks_guard_ap_capture_source_version",
    sha256: "f49975ac3f58b01819de3fa995ad60ac02215a8a5b5d9945d9654379f98e6574",
  },
  {
    name: "openbooks_guard_budget_line",
    sha256: "2781a16dca1c9e08ce87e4640343a673baf8fd37dc81d8d26d5f07cf5bb99994",
  },
  {
    name: "openbooks_guard_budget_scenario",
    sha256: "aec8fa32f4d454de8223045d4ad73fbe5b6cbb5ebb088637a11a72fb45211dc3",
  },
  {
    name: "openbooks_guard_depreciation_evidence",
    sha256: "6190f0e93e8878123908f1f567892d5f0ed5782a7aaa9faebf30d1f647c16d9e",
  },
  {
    name: "openbooks_guard_finished_ap_capture_run",
    sha256: "db3f8446ad785d1b92e9e7fce09f58522d4180d9c340b8cb6d27fa75aa17d45e",
  },
  {
    name: "openbooks_guard_pay_run_bank_file",
    sha256: "f6cfcc17a384d7c68fba8ece42d685bd96ce40b8eeeaea5e0212d2a6201e5d3f",
  },
  {
    name: "openbooks_guard_payroll_bank_file_blob",
    sha256: "cbab19c98cb81d37b12fdf0f6ee7f9bd4f059cfd663559d0d9d12574d20c36f0",
  },
  {
    name: "openbooks_guard_payroll_bank_file_file",
    sha256: "8b1e26e04aebb8e550a40441660b82fdde94967d2f96ccd991aa6722b3387e4e",
  },
  {
    name: "openbooks_guard_payroll_bank_file_version",
    sha256: "4c9747e8c4e63f4f5b34c7df406aa58ce9f5fdcec7319bfbc6424f060f1304d2",
  },
  {
    name: "openbooks_party_payment_stats",
    sha256: "d1f84260a2e8e8cf6c324759fbeef57f032e481e04b07fdd4daa4fc91fe34247",
  },
  {
    name: "openbooks_reconciliation_match_guard",
    sha256: "9f1e32b854b8f966e1e37afbac93f1b5bbebbcd05b151da05cb12f64b868ca3b",
  },
  {
    name: "order_line_cancellations_append_only_guard",
    sha256: "7a782502a62a99ca8caf6ca702b4560a72119c6bf02c4d173cd3509b9b1b8695",
  },
  {
    name: "org_business_calendars_history_guard",
    sha256: "2bd22a5308a1f5da9c7e563fe93a0094f9d503be88cc7aa0b7548e31338ca42f",
  },
  {
    name: "pay_component_earning_classifications_prevent_orphan_delete",
    sha256: "8137f80212bd6d6c0987c647c8e3d3c112d2ef2755bf06ab2d73185f75058f9c",
  },
  {
    name: "pay_component_history_guard",
    sha256: "f0ead9e55daefcb55057d74227cc9410fcc9c96704a8f318c10108f6d213d8c8",
  },
  {
    name: "pay_component_statutory_treatment_preserve_committed",
    sha256: "14c4db9f621bf899259d58d6e33d766fc9e125225240aac2eb95f48252a3b6bf",
  },
  {
    name: "payment_event_immutable",
    sha256: "703820e2c3a1013d117df32c43ec288bf2feb20491c912e02d7017dba2d2a4a9",
  },
  {
    name: "payment_run_item_guard",
    sha256: "8fe0c6aff0cfc9528429baa03f46780e626cafe1efd8ed134bedbef0bed43a5f",
  },
  {
    name: "payroll_annual_period_bounds_guard",
    sha256: "b0934f0f9930ec7800cc8286bf0c0469528f9b5c4d400c60603688ba6e8b73fd",
  },
  {
    name: "payroll_compensation_calculation_guard",
    sha256: "9bf4bdfb630110ea8731d08aae67eb08bdc5cd5e5c302b819991d9d88478009b",
  },
  {
    name: "payroll_compensation_configuration_guard",
    sha256: "1a4ea1bb3741cb16429bdbb60c94218171283e45f00ee52aaa32458d58a14f0e",
  },
  {
    name: "payroll_employee_employer_assignment_guard",
    sha256: "f1474d009dd0e9276be0c52c5e7bf93c7ef633f72e52e250d60facc82d8641f3",
  },
  {
    name: "payroll_holiday_allocation_audit",
    sha256: "61c473adadc109c7f0d90259fa62b1258663fe3627f175681763bfe74a03a4a5",
  },
  {
    name: "payroll_holiday_allocation_guard",
    sha256: "1868461bf68220c4969db8657957f7eaa7d5d98464a5060afc10143a204eed9f",
  },
  {
    name: "payroll_holiday_obligation_guard",
    sha256: "91f56340922be70370d52d89c669a99fb6458134c6974ee83d63cf715ad4e12c",
  },
  {
    name: "payroll_period_opening_guard",
    sha256: "c03aba9b5e0a215518f7cd976d5527399e5bdf14bd618142c58b31c352d4e66d",
  },
  {
    name: "payroll_program_period_bounds_guard",
    sha256: "b64f55188a39928326eacf09f7a20ad9ec17ce0b9e341ae6fe9e2a8337089c3d",
  },
  {
    name: "payroll_service_configuration_audit",
    sha256: "2bb2d1b15b48142adeb8a29e3711dad3e0c00165998179f355cb017710ebd266",
  },
  {
    name: "payroll_service_configuration_guard",
    sha256: "6ac030125b6caa98e1e8a293704160c57f95aeac53488eb31386c78cf45686ab",
  },
  {
    name: "payroll_work_location_allocation_audit",
    sha256: "e28337e0ef26347c422accb607a0e14549c6332a189284e668faca1b964aa45f",
  },
  {
    name: "payroll_work_location_allocation_lock_committed",
    sha256: "06a75b03f20e6de17d1d944ccea9d7bc58574cda9a1b84feef0a36525462da79",
  },
  {
    name: "pick_execution_history_guard",
    sha256: "6675b41773ba7d0e780fc4af92adbed3d0712a8a979151285f50e700bafc1b48",
  },
  {
    name: "position_changes_immutable_guard",
    sha256: "df87953844fc19d4951b81f9fb59eff39f7abd4cef092e981878611f9b5dd42d",
  },
  {
    name: "position_versions_closure_guard",
    sha256: "8e76bc2f6ff00b7977134f9f829de4ecbb855bad72294a25ceec69d14f643550",
  },
  {
    name: "preserve_historical_compensation_cycle",
    sha256: "d4eccf072e15d665398d2e78899dd28760bd0cf710aadedd970985d702b5ee98",
  },
  {
    name: "primary_book_history_guard",
    sha256: "bac7038f8e1a8a71ba77fc0353678ffd3ff8f3ceaad140f4b2e1bbba4724582f",
  },
  {
    name: "project_delivery_evidence_guard",
    sha256: "90f6b8629e4bf0a2fd2fa2d122a2d8328f4f8d698a5e6ea393a7263163071703",
  },
  {
    name: "project_financial_adjustment_guard",
    sha256: "ba265cb9c6f0b3d2fadf9acee953bc302fc4219126bbe07115bf3aa413e5d540",
  },
  {
    name: "project_financial_profile_version_guard",
    sha256: "738be67b3d035dabd7af11b684ca513b6c42e1e7af9811a1bd73f644bbac619b",
  },
  {
    name: "project_overhead_adjustment_guard",
    sha256: "1754d5277624f2248651c0cc57e98c1ac33e8f860cb2211496c82b12dd63364c",
  },
  {
    name: "property_financial_evidence_guard",
    sha256: "e64cfe122d93789c0a64e2410b9e6eaa213f5ee501dc81cdee65a0b943a76ba1",
  },
  {
    name: "protect_application_idempotency_key",
    sha256: "1972cf0709d1c70ba282f05046deff4e8deb311235964166c0e925526e93d0cc",
  },
  {
    name: "protect_country_tax_pack_installation",
    sha256: "a77c1c221ecd79d284d26e35419ea97d44aedba30f9f4feed10c8423b5120069",
  },
  {
    name: "protect_org_base_price_level",
    sha256: "3acf699fc53c9df67a5240e56378a8470210221b6008707c8d28e69bd98de7b1",
  },
  {
    name: "protect_pricing_customer_role",
    sha256: "3d82d2ff31a128c0f932c963ff29a02209692966c48267fea22f55af2876622d",
  },
  {
    name: "protect_tax_provision_history",
    sha256: "d97e46fcd7752fa5eec576792ec10443bf4fe1d3cd5f05b6a77024b54d59434d",
  },
  {
    name: "protect_temporary_difference_history",
    sha256: "677df694d5525b671ce6eeb3f8bdd11fca79730a3e7de988693bec3c6f77662f",
  },
  {
    name: "provision_identity_guard",
    sha256: "03aad968bc3e6e396b6a16b679fb91a6f77fd2e7fbde21e4b28f4f1954725f99",
  },
  {
    name: "rate_adjustment_target_version_guard",
    sha256: "8d3662d80c3bbe419040a4b302211223f9e705d11686af3932a044b41528f682",
  },
  {
    name: "rate_book_currency_guard",
    sha256: "8b50942579e305f23f4b0cb174ff4f62735fdff3048f813f8f5595c36ae64487",
  },
  {
    name: "rate_version_child_guard",
    sha256: "1c6a2c19dce2d753eb1f81a10fb24701677f1df4cdb77d4878921c1a731e1e58",
  },
  {
    name: "rate_version_immutable",
    sha256: "ce293e6767e40d1ec0838aadcb2bfc417f0cc2f165079c8c22e1b9c5cd72eb77",
  },
  {
    name: "recognition_revision_history_guard",
    sha256: "05a10a1ab732449914565ab6e3bc7e8ce1b8faea1af870964f71f1a052280474",
  },
  {
    name: "recurring_occurrence_document_immutable_guard",
    sha256: "0686abfe2fa5f65a8808baa3035d13aca021ecf3b1f285746c45612352af91e7",
  },
  {
    name: "reporting_relationships_closure_guard",
    sha256: "2136f7308beee0af0fe379d9e00f19179fc6ca7e3494eb7168f5d1cbb8b0452c",
  },
  {
    name: "saas_metrics_fx_evidence_guard",
    sha256: "e4bedd42fddfcb67b43e1eb47ed4f012b01993689f6148c6671ee0e7e48061a0",
  },
  {
    name: "saas_metrics_normalization_request_guard",
    sha256: "879b07d87673ee5f6800f20a43a4c1fa448f8050c2011f85fb2c118740e6857e",
  },
  {
    name: "sales_evidence_immutable",
    sha256: "4df5bdace9684470f6835ca7d344438409a88c1650235410d5fe3c10f1c0704e",
  },
  {
    name: "sales_quota_version_guard",
    sha256: "5b9db55547f9dc528b15a3d4d1515676b0d831f8d3011681b432bacbfb852449",
  },
  {
    name: "schedule_boards_guard",
    sha256: "37b10c7cfccd4dcf35cf120ba556d264d4851d724c81598a21731c949386173e",
  },
  {
    name: "schedule_codes_guard",
    sha256: "1dda2b3e9943c243fa8222c699da8170a6b27e869b509ac0d86859a1a7fe826c",
  },
  {
    name: "schedule_distribution_snapshot_guard",
    sha256: "eb0a898ddf396edd67589f4a09e19e2e01f216f878c801fdbd968924ef160293",
  },
  {
    name: "schedule_entries_guard",
    sha256: "ca34088a3a194f38e1cc636b2276f855df13c143ba132b5f5a0d43d3c3d2e5ac",
  },
  {
    name: "schedule_roster_guard",
    sha256: "1623f069400d035106ea69d1bc4adea9762d56004c82b69d0923ba31cc8123a1",
  },
  {
    name: "schedule_attendance_guard",
    sha256: "8ade53a31ede08e83da2f91d97e9cae5723b7cdbee811c5c526f72849bc3ebc6",
  },
  {
    name: "service_record_guard",
    sha256: "e170442faf95f852719ca910cfece6460937a5ee3d6b7ff50b7af14e15e42bf5",
  },
  {
    name: "service_history_guard",
    sha256: "0b2538ad7ab29533dc0ad9913a77b05d4e461df523a4318e15c542ed6efee571",
  },
  {
    name: "schedule_source_records_guard",
    sha256: "842dfbcc6955650ff1f4b57b571ae9f5c88139ed379fc60338d8b9d6fa1282fc",
  },
  {
    name: "scheduler_outbox_terminal_audit_append_only_guard",
    sha256: "e06165f8a6c619f2f5e0330903ff5f452a9ab99f1890fc4e976fa837ac6fed65",
  },
  {
    name: "segment_definition_guard",
    sha256: "2ea0c74c89bf6cd02a84e4a119e0d5a587deed667b19bc58451520a94683f378",
  },
  {
    name: "segment_values_clear_default_for_wipe",
    sha256: "192f2debaca0fbf7b3194a761311508400376928790129973bba01afc13e4ccd",
  },
  {
    name: "stored_value_entries_immutable",
    sha256: "d927e8e75615245d5cf99cec4d6eeaea396be4985efc111cbec42b6058584247",
  },
  {
    name: "subscription_amendment_immutable_guard",
    sha256: "3c1da0c44f593c4527ced4a54f4f404e4c3282136f9fcfd54eabcdbe61997f80",
  },
  {
    name: "subscription_period_invoice_immutable_guard",
    sha256: "23d0de0c0229e73837d6512a1e5101c2c78956de5d64c666746a93f1781cd182",
  },
  {
    name: "subscription_plan_version_immutable_guard",
    sha256: "c8fe1c60cb2aec5b713eaf88b737a5690c25bba90e6825c23a4197ae2127f3e3",
  },
  {
    name: "subscription_version_component_immutable_guard",
    sha256: "02be1977312662234c76201fb184116c3faf3134152b42e2493f50ab37aad750",
  },
  {
    name: "subsidiary_tree_guard",
    sha256: "0b5767d39aa05642b6838d3e9076bf9b7d4dab898fa672044e80a909d45e43d4",
  },
  {
    name: "tax_filing_immutable_guard",
    sha256: "e349880078c43089986ecbb508e2ecf10fb108a6da4a37010e0b86f3d064c9f9",
  },
  {
    name: "trg_application_open_balance",
    sha256: "525c5a29d7ab304d49b57903b61cad23b8645f110be919acc7629c9dee3bca5e",
  },
  {
    name: "trg_journal_line_open_balance",
    sha256: "66b229cd6249b55ea2ce95f59d0269f023557da9e058ec65905b95a9eeadf00b",
  },
  {
    name: "usage_prepaid_draws_append_only_guard",
    sha256: "1a225c03a8c7331a2153573dada85fb1ae4650013d58f739cd811e7df0fdc5d3",
  },
  {
    name: "usage_rating_bands_draft_only_guard",
    sha256: "b26b1a23b258d50c89ce8d325f22959ceb37372cecffcff9de6d6092db4a38f4",
  },
  {
    name: "usage_rating_published_immutable_guard",
    sha256: "771b81372107771d669c23bd41902a3819aafeb8e4e3ca6324333a45811b8960",
  },
  {
    name: "warehouse_execution_history_guard",
    sha256: "0c5ef4f71e53ad59a12393563c90b21ce24c28de4e34f575efb62c68f82ba096",
  },
  {
    name: "warehouse_execution_task_guard",
    sha256: "069458124b9d9fac6696ffb2c7bba6efa5df9d8d3ab5cc96d29715723f6e4c62",
  },
  {
    name: "prebill_event_append_only_guard",
    sha256: "0a43989514038d7da4d58d6b9ed3ec2aee530e3af0f6c6bd75368ad4ed556b2b",
  },
  {
    name: "withholding_deductions_guard",
    sha256: "7fdd60eac96af3fd2b292a96a98a60cb16ca7d6226c49316c9d8bec1f851341a",
  },
  {
    name: "withholding_returns_guard",
    sha256: "378492d95d6d89fa810080fa5d1a4cd8b1f05693e0f7a565ae1fe781f5cb8814",
  },
  {
    name: "worker_employment_versions_closure_guard",
    sha256: "7154c9c44fe3b809e2c3f1e583fe2ad9d7518e4704618edd4935894974454965",
  },
  {
    name: "inventory_inspection_guard",
    sha256: "2f70e53880dbd1ba12c9ec717d1a07f17b422b65ef2c6b82025f9fd136b00dba",
  },
  {
    name: "inventory_inspection_plan_guard",
    sha256: "eeb4cb150fb455ec4e112b0a61ecfce5aca02d5179ece9c5b423e695890ee5a6",
  },
  {
    name: "manufacturing_completion_trace_guard",
    sha256: "ffdd0af706b48efe4aa129c5c60854976b1425cc18046a407c99cfd9dda5ec85",
  },
  {
    name: "manufacturing_loss_event_guard",
    sha256: "cf0a5f7ebccce75940bd50d6759ab6152625acdf05d140be7b936837a44954de",
  },
  {
    name: "manufacturing_routing_operation_guard",
    sha256: "1adc332d19775925ee422fc05c9971d5676f42950a198da540c033a1170e8e5f",
  },
  {
    name: "manufacturing_snapshot_configuration_guard",
    sha256: "ffa91fa3734e9b87601a8113eca9af71a1dc553756390852b166b5f73234604e",
  },
  {
    name: "operating_profile_version_immutable",
    sha256: "3a046c0386a9f7235041a3daf65d6050cae83d432235cc18913f60da56a2a1e1",
  },
  {
    name: "production_bom_revision_complete_guard",
    sha256: "83c6996d0c0a971eb30726ed7bb50eb32660333eef94e7a7b9285a0018ba61de",
  },
  {
    name: "production_bom_revision_guard",
    sha256: "4ceb220937a7cd8673072332b610d5ed1ba1e4148191114e17fa830ccc54c171",
  },
  {
    name: "production_mrp_run_evidence_guard",
    sha256: "6e1dec4430843c6cd8c98c5e7a8c753b265dcc9393a73ae09e06070ed60285e1",
  },
  {
    name: "production_subcontract_guard",
    sha256: "69314c560cc4731d7b79b3baf143535d03137f6eabb6e7fdeb62e2ba8b7cb0d1",
  },
  {
    name: "production_subcontract_material_return_guard",
    sha256: "61852036a10829759b618bd83fdd9027e8a2688a796ef3732da964bc509e3b44",
  },
  {
    name: "production_subcontract_return_guard",
    sha256: "b7c83b0e49d2c03e3fe859e9a83cc790238d3481c2ee3f3a5ac2416a8aafd600",
  },
  {
    name: "production_subcontract_service_guard",
    sha256: "dfc4ac97773b7e725258727e1a43640a0899b695927f02951b7a8deb8eb00cb5",
  },
  {
    name: "production_subcontract_shipment_guard",
    sha256: "45c77b504b342953bfee5b7956bcbcab1618cbab512d1037ea28748ee537de21",
  },
  {
    name: "production_time_history_guard",
    sha256: "3e183f14cc7ae30730320daaaf841d8807b01a7e19bdab996139d86c03786a34",
  },
  {
    name: "payroll_prior_earnings_guard",
    sha256: "aca581caf6ef846a3319eff6c0ec99850823d8f5678fc7e1f6a25f09837d6d08",
  },
  {
    name: "period_end_journal_policy_guard",
    sha256: "c2277350b9bc1efdeccfa8961a7316610f7abea719421bb6981446a58b20b929",
  },
  {
    name: "period_end_journal_set_guard",
    sha256: "2b3d68814dad441e2301e8b9eaee04ac9b05d9c4149c11ebf4baa7f6403a3681",
  },
  {
    name: "period_end_journal_entry_guard",
    sha256: "07f9d2d53dd8951b3ada47c1f9847194b1ee03322602a00affa119884fe7eeec",
  },
] as const;
