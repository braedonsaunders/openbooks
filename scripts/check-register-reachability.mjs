#!/usr/bin/env node
/**
 * Campaign register reachability checker: a finding recorded fixed must have
 * its fix in the history main will ship.
 *
 * The defect this gate closes: work committed on a worker branch that was
 * never merged is invisible to main while its finding is closed by the
 * worker's own report. The register trusted the report; nothing checked the
 * tree — a launch decision made from the register alone would have shipped a
 * recorded-as-fixed segregation-of-duties bypass believing it was closed.
 * The drift is real but self-heals at an unknown rate, which is why it needs
 * measuring rather than assuming.
 *
 * For every finding recorded fixed or resolved in the goal register for this
 * repository, the checker resolves the commit or branch that closed it and
 * asserts that commit is an ancestor of main, classifying each entry:
 *
 *   reachable      closing commit is an ancestor of main — verified shipped;
 *   unreachable    closing commit resolves but is not an ancestor of main —
 *                  fails closed; BASELINE below records historical drift for
 *                  diagnostics, never as an exemption;
 *   unresolvable   the reported closing commit is not a commit object in
 *                  this repository (the branch it lived on was never fetched
 *                  anywhere and its objects are gone);
 *   unattributed   the register does not say what closed the finding at all
 *                  — recording fixed without naming the fix is the defect's
 *                  root mechanism and fails closed;
 *   unverifiable   a shallow checkout (CI) cannot resolve historical
 *                  commits; reported loudly as PARTIAL PASS, never counted
 *                  as either verified or a violation.
 *
 * Every gap fails closed, while the ratchet still cuts both ways: a gap NOT in
 * BASELINE is new drift; a BASELINE entry that has become reachable fails
 * ("reachable now — remove from baseline", so stale metadata is visible); and
 * a BASELINE entry whose class changed fails (the tree or the register moved
 * underneath it — reconcile before trusting either). A machine-readable
 * IRREDUCIBLE_REGISTER_ROWS_JSON record lists every unsupported row and the
 * concrete evidence sources attempted for it.
 *
 * Ref choice: the register's contract is the local integration branch `main` —
 * the ref the orchestrator will push to origin as the goal's final act. The
 * remote-tracking `origin/main` may be stale while integration work is in
 * progress, so it is never selected implicitly. An explicit
 * OPENBOOKS_REGISTER_CHECK_REF override is resolved as a commit and fails
 * closed when missing.
 *
 * BASELINE provenance: published 2026-08-27 from the goal register
 * (statuses fixed/resolved) at remediation start, from a complete
 * (non-shallow) checkout. Attribution order: a commit named in the closing
 * report, else a hex token in the report that resolves to a commit object,
 * else the newest commit whose subject names the finding id, else no
 * attribution. Baseline rows are the honest size of the historical problem,
 * printed on every pass rather than amnestied. New findings recorded fixed
 * append to REGISTER with a closing commit; a finding whose fix reaches
 * main has its baseline entry removed in the same change.
 *
 * Campaign probes: set OPENBOOKS_REGISTER_JSON to an exported findings
 * document or OPENBOOKS_REGISTER_DB to the ultragoal SQLite store. The latter
 * reads fixed/resolved goal_findings for one thread (the explicit
 * OPENBOOKS_REGISTER_THREAD_ID, or the latest goal when omitted) and joins the
 * latest integration commit before falling back to the verification note. A
 * live source replaces the snapshot for that run. Its finding IDs are the one
 * authoritative cohort: historical baseline metadata is projected onto those
 * IDs before auditing, so a baseline row from another campaign can never be
 * reported as a live register violation. Projection does not waive a live
 * unreachable, unresolvable, or unattributed row; every such row still fails.
 * Malformed or empty sources fail closed.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const REQUESTED_REF = process.env.OPENBOOKS_REGISTER_CHECK_REF || null;
const CHECK_REF = REQUESTED_REF || "main";
const BASELINE_DATE = "2026-08-27";
const LIVE_REGISTER_JSON = process.env.OPENBOOKS_REGISTER_JSON || null;
const LIVE_REGISTER_DB = process.env.OPENBOOKS_REGISTER_DB || null;
const LIVE_REGISTER_THREAD = process.env.OPENBOOKS_REGISTER_THREAD_ID || null;

const BASELINE_CLASSES = new Set(["unreachable", "unresolvable", "unattributed"]);

/**
 * Every finding recorded fixed or resolved in the goal register for this
 * repository: [finding id, closing ref]. The ref is the commit reported to
 * have closed the finding (full sha when it resolves, else the reported
 * token), or null when the register never recorded what closed it. Append
 * only: entries describe what was recorded, never what we wish was true —
 * the tree, not the report, decides reachability.
 */
const REGISTER_DATA = [
  ["fnd_018b450d_de435b", null],
  ["fnd_040063a6_6655aa", null],
  ["fnd_04a10801_efb02d", "03f01f8b6204fbe771f5fcda884b681373a304fd"],
  ["fnd_04e41fe5_f3f613", null],
  ["fnd_069e20fb_aa8302", "c48c12ce6bbe3c95c581e5d4106efd858185aed9"],
  ["fnd_08d314af_52afcb", null],
  ["fnd_0d522d40_84e557", "9da48ec2496df2c11ff6b6844a6a5b9f78d6ad49"],
  ["fnd_0fc81515_37cfa1", null],
  ["fnd_0fed3e7a_e45285", null],
  ["fnd_10e62337_1cdaaa", null],
  ["fnd_1440f766_cf9756", null],
  ["fnd_1642d5f3_c04692", "2fc361432ac2421e505b00bb662cd93264988329"],
  ["fnd_192456a6_f4f910", null],
  ["fnd_1c61887e_a94923", "26b69bc18730a6e06ac6b9125539190979279bc4"],
  ["fnd_1d1c9297_cfe976", null],
  ["fnd_24dfd85d_ff16d2", "09e0e9944dd6bef1343038b86a18e31951f4e01d"],
  ["fnd_255eda65_3437e2", "44e0cd08fec2c52974ee98be1b011fff9aa30e69"],
  ["fnd_26619e5e_9457b9", null],
  ["fnd_2872f07a_1f0993", null],
  ["fnd_299f9d00_b8bb80", "a022ac5c0f696b57b3fc3b03d6d5aecc9d37bc31"],
  ["fnd_2aa931e8_1c94f7", null],
  ["fnd_2b50a6e1_c3cade", null],
  ["fnd_2b650e02_d78752", "2fc361432ac2421e505b00bb662cd93264988329"],
  ["fnd_2b93f017_665325", null],
  ["fnd_30e3ebb1_4efe75", "7f177519148060ea2774cdbba9ade65db339e22a"],
  ["fnd_37932d26_500541", "206149ec60c7f2de1967f039484befc2cabefa25"],
  ["fnd_38aad0b8_0c6b88", "2248ff63cdba4e58a734c17b427530ae1c1a19b7"],
  ["fnd_3a3d9be5_bda2a6", "2496b9ceef84ca0396f1a034492a3c5f91b7b62f"],
  ["fnd_3b65cf28_ffcb7e", null],
  ["fnd_3c97b269_8b257e", null],
  ["fnd_3e38f9d1_e2ae4b", null],
  ["fnd_3f685d1f_907f76", "fa819c46d4c1e496079eeac7a9300c2feb1f08c9"],
  ["fnd_421d5f16_2b6657", "44ecb4d818873f88ceb5606d43624f7c579a6151"],
  ["fnd_461bea26_8fd15a", null],
  ["fnd_4992e18b_9c685c", null],
  ["fnd_4afdaaca_5dfa95", null],
  ["fnd_4c6c59ff_a21e0f", null],
  ["fnd_4d319df5_30400e", null],
  ["fnd_4f34882c_ff599b", "2fc361432ac2421e505b00bb662cd93264988329"],
  ["fnd_510b1782_bd65b3", null],
  ["fnd_5649f7e2_bab03f", "2fc361432ac2421e505b00bb662cd93264988329"],
  ["fnd_56e2f1d3_73d494", "45c705a3e885e521dcd2f60465c597f89f032dd4"],
  ["fnd_574198e6_08be98", null],
  ["fnd_5830a195_030c0e", "ff1f25b8afdf0f27871352c186eb3435f0ef4296"],
  ["fnd_597f7ddf_5adcb8", "2fc361432ac2421e505b00bb662cd93264988329"],
  ["fnd_59993902_1dc251", null],
  ["fnd_5d51dcb2_0ca8ae", "619d5409c4e7071dcb8e47307f9312eb7266c479"],
  ["fnd_644008a8_9963bb", null],
  ["fnd_6495b21e_f4b91c", "4f9f2bc43482d96baa6e5be094a5b868e3d36d54"],
  ["fnd_64b310ff_fced12", "2fc361432ac2421e505b00bb662cd93264988329"],
  ["fnd_67b82c5b_7ecef2", "9313a845abe57cb2fac7905d7c3ae63b2e8106e3"],
  ["fnd_6827600b_ef565e", null],
  ["fnd_6844af5a_14f5da", null],
  ["fnd_68f990dd_e5cb20", null],
  ["fnd_697c3d37_3a32b2", null],
  ["fnd_6a582972_18e497", "9faee2ebf0923185e7d5d3fbad3387f51faf6f05"],
  ["fnd_6a5d52fa_a5a3a0", "45c705a3e885e521dcd2f60465c597f89f032dd4"],
  ["fnd_6a8c6921_9ffdd4", null],
  ["fnd_6acd3c58_1e7df0", null],
  ["fnd_6c8f6ce0_98a7a3", "8a002960303ea757f2bead4ca3096e027028679d"],
  ["fnd_6ccfaed5_752f7a", "54be6d3d031a57c1f8d8b7180466f62e4e384f65"],
  ["fnd_6cf09ba6_c05581", null],
  ["fnd_6ec65665_e4848b", "73e2cdbac0a47456fc0d4dcce6fef7f228950e08"],
  ["fnd_70c829d9_115fc2", "948eda9c71a852d55f108975ce11e3b649acb2b3"],
  ["fnd_7319e252_0a39a5", null],
  ["fnd_73fe5454_8fa51c", "c94d52b6cc3c1f1bf1eaab2bd4ad03f5522ad0d0"],
  ["fnd_77376743_7fd96a", "b4365ffac2d11a1c1eaa3f06025375b15ac6b413"],
  ["fnd_7a204369_c63b7d", "a282cad7e7bec11de506f76cbd9f7027456b7f21"],
  ["fnd_7c110457_f37fef", null],
  ["fnd_7c402f33_7ec766", null],
  ["fnd_7f4b9165_04c3da", null],
  ["fnd_7f75a7e7_aed241", null],
  ["fnd_80b3dc55_db2f1f", null],
  ["fnd_80c456a3_09a85f", null],
  ["fnd_815b6d7d_de3a32", "d54f7bea729de9e441276300d6b6b26a187bf7ac"],
  ["fnd_821c5702_033b3a", "2fc361432ac2421e505b00bb662cd93264988329"],
  ["fnd_82904c62_85f4ed", "44ecb4d818873f88ceb5606d43624f7c579a6151"],
  ["fnd_83a2c3ca_0482a7", "f7bcf43af19b19d3a7d367fe348f07c84d97e0e7"],
  ["fnd_84077a9c_bc371b", null],
  ["fnd_844e9c12_cc86f3", null],
  ["fnd_84a1dbbb_832e7c", "c85153fd2db14796edf7264418f52ba937f21abf"],
  ["fnd_85323ce2_4f0c4b", null],
  ["fnd_8ae2ccb8_9a2063", "ca176905f51436f524415fb52a7d3e0c79eafebe"],
  ["fnd_8af1095c_af50d5", null],
  ["fnd_8af82a06_e94d88", "45c705a3e885e521dcd2f60465c597f89f032dd4"],
  ["fnd_8c12a82f_a05ead", "c0fca24448c291909b567edddc694a319e0f736c"],
  ["fnd_8ee4529a_4b560d", null],
  ["fnd_9251a1a4_f53bbb", null],
  ["fnd_9435bc25_c0b8f4", null],
  ["fnd_94d974c9_ed9a07", null],
  ["fnd_97fba149_c7beae", null],
  ["fnd_9843aa70_2baa0d", "459b3ae35533c4683708c1135b6be3a2a1ec4ca1"],
  ["fnd_99db4bea_12141a", null],
  ["fnd_9bad2b47_ba541e", "1ca023d4b11a22ae542797e4f60e57414b9ae7db"],
  ["fnd_a02c07d5_82fd6e", "44ecb4d818873f88ceb5606d43624f7c579a6151"],
  ["fnd_a08f4ac8_089cca", "d0c34c1f6c37c095b9be6f7f0ae28611e3c105d5"],
  ["fnd_a11ac2c2_e6ce78", null],
  ["fnd_a21eac3e_210929", null],
  ["fnd_a2d284ac_e1911e", "c0fca24448c291909b567edddc694a319e0f736c"],
  ["fnd_a4b43519_7b313e", null],
  ["fnd_a639aeb0_318060", "86fc60f098b188b626712ca2ef90ca3dd3634d27"],
  ["fnd_ab9deb28_991520", null],
  ["fnd_ac6c98cb_72cebe", null],
  ["fnd_adbfd70d_36bf98", null],
  ["fnd_aef54274_e1ce97", "0b99d7974eaed638faf20348cef9b98bb7c942c1"],
  ["fnd_af606d75_d64ab4", null],
  ["fnd_au_cancelactor", "11abaaebdf1e625a3bb9197764a4526a298a0e66"],
  ["fnd_au_gatesratchet", null],
  ["fnd_au_importatomic", "2fffd92acd0e5824ed791ab9e5756e156bfd8180"],
  ["fnd_au_importval", "2fffd92acd0e5824ed791ab9e5756e156bfd8180"],
  ["fnd_au_platorphan", "d986d484585cb16ccd2a27c54994b7291e86eecb"],
  ["fnd_au_publishqpdf", "84744b3f744a00f7f3afaf8ef309f81389373d87"],
  ["fnd_au_recarr", "440dc472b63631c1d15df0ede521504a6b351f70"],
  ["fnd_b03b93e1_ada036", null],
  ["fnd_b0605e0f_6bd5f6", "2ef234ab1fec3de4eeb472e0a57e05ad97859efd"],
  ["fnd_b320d624_cb733c", null],
  ["fnd_b36ecd91_bbf47a", null],
  ["fnd_b521df02_f74e00", null],
  ["fnd_b5970bab_d667a3", "8fbe02704b95be2c519e0811e3e13037d1a29700"],
  ["fnd_b6515287_1b9800", "b4f36730c344a496c23020e11d50e0dbbf3ecfb8"],
  ["fnd_b6d6b92c_3c93b8", "c665846ed0d2571171ad06802058e6259cd7bad4"],
  ["fnd_b9589fd7_60b299", "2fc361432ac2421e505b00bb662cd93264988329"],
  ["fnd_b99f4ba4_4a9211", "878a75440c17612842d461d07851e871a80e4d53"],
  ["fnd_bbd256d1_4013e8", "c94d52b6cc3c1f1bf1eaab2bd4ad03f5522ad0d0"],
  ["fnd_bccf46e8_f3ef1d", null],
  ["fnd_bcdf3627_72beac", "2fc361432ac2421e505b00bb662cd93264988329"],
  ["fnd_c0c56289_3e5981", null],
  ["fnd_c2423a10_5de834", "f7bcf43af19b19d3a7d367fe348f07c84d97e0e7"],
  ["fnd_c72cb529_73b9de", null],
  ["fnd_c98f837c_cd1176", null],
  ["fnd_ca1355f1_727712", "f7bcf43af19b19d3a7d367fe348f07c84d97e0e7"],
  ["fnd_caf101af_c15701", null],
  ["fnd_cc43700e_ade620", "e883bc3530cde6f1659c4dc4dc0497499131106e"],
  ["fnd_cc6d57b7_d8dd01", null],
  ["fnd_cc767fcf_ba9969", "8bddf466f1080037bb83d00e0d8792d50cb77ead"],
  ["fnd_d0abb66d_11e96d", "fa819c46d4c1e496079eeac7a9300c2feb1f08c9"],
  ["fnd_d2321082_57cf9c", null],
  ["fnd_d278f487_2a57a4", "44e0cd08fec2c52974ee98be1b011fff9aa30e69"],
  ["fnd_d3eb5d98_28c85a", "45c705a3e885e521dcd2f60465c597f89f032dd4"],
  ["fnd_d46f1bdf_6db94a", "45c705a3e885e521dcd2f60465c597f89f032dd4"],
  ["fnd_d506f57f_c2509f", "5f72f9f8fc9de071be8bb0b1a7557393061ddd4c"],
  ["fnd_d903ce80_f886d7", null],
  ["fnd_da3b2b0e_ba22fe", null],
  ["fnd_da55a18b_4ca29f", null],
  ["fnd_da9f93cd_4ebc6b", "189ef965d6b20f814698e5761caa0b62143f73fa"],
  ["fnd_dac13093_c06709", "2e3f6f8b719a817b1b8dd4d53a6e6cfef720aaba"],
  ["fnd_db990c34_58b0ad", "9faee2ebf0923185e7d5d3fbad3387f51faf6f05"],
  ["fnd_dc0ca0a5_885180", null],
  ["fnd_dcc4eaaa_8877de", "2fc361432ac2421e505b00bb662cd93264988329"],
  ["fnd_dcf29488_68f38a", "443303201c6ef7565cfb30561c8e36f7b7ec41a7"],
  ["fnd_ddae2dd2_92aed7", "43ee270b456961a704bf7c6955383dd890a7d160"],
  ["fnd_df8faf6c_3e052f", null],
  ["fnd_e84f6947_19ebeb", "4b6267ef7ad2dfed5075d1dcff1963ea56f914e8"],
  ["fnd_e9a0ec01_449310", "32d327e931b7affb2b3e458f827e89628c5683b8"],
  ["fnd_ebb5fa58_3db60e", null],
  ["fnd_eecda252_783443", "12540a835db494bed8c750adebe14607bd451c40"],
  ["fnd_eef2fe98_4a4c53", "948eda9c71a852d55f108975ce11e3b649acb2b3"],
  ["fnd_f1a324e5_c23f05", null],
  ["fnd_f1c01a19_80c40d", null],
  ["fnd_f3336505_de4203", "09e0e9944dd6bef1343038b86a18e31951f4e01d"],
  ["fnd_f3ac5f5e_b9ff77", "f7314bb8929f85264f1d2725d5468b782da2a7f4"],
  ["fnd_f40ce24a_881fae", "255b7674d103b4c5490f032df199e2abb71f63e1"],
  ["fnd_f410d9a3_0b5665", "c70b8eb26ff6d57aa03b6e2a267711c63dd38df3"],
  ["fnd_f6d05c34_122968", null],
  ["fnd_f791d71e_479414", null],
  ["fnd_f8e9e947_e7856a", null],
  ["fnd_faf08cc6_bd0ff0", null],
  ["fnd_fb3f8a2f_3a6074", null],
  ["fnd_fc0325ae_97c157", "8bddf466f1080037bb83d00e0d8792d50cb77ead"],
  ["fnd_ff21970a_73f04b", null],
  ["fnd_ff47a174_c9b691", null],
  ["fnd_intake_pgarray_02", "39dd1e57532ba87120e55fe811a96f8e03877e6f"],
  ["fnd_intake_qpdf_01", "d776c26db6b417b473277667496155909c6c1997"],
  ["fnd_mt6g89d5_7irug4", null],
  ["fnd_mt6g89iv_yul85n", "8a87a6abf1270f107b259527d956e3fa08af3c39"],
  ["fnd_mt6g89oj_cpk530", null],
  ["fnd_mt6g89ug_ggc4yz", "24211ac9"],
  ["fnd_mt6g8a0w_5o5636", "754b2ac7"],
  ["fnd_mt6gfs13_ujfk0k", "3fdbcdf9007927cc68b681cf1426d342b1560dac"],
  ["fnd_mt6gk4yo_sh9m3d", null],
  ["fnd_mt6gkn8t_v39f6j", "185e0d41aa1264d9738dd80e0aa78532f02732e1"],
  ["fnd_mt6gmbvt_y36mdn", "029e31fb97cba6c3a86f4ae8f3b6ae5ac9eb41e6"],
  ["fnd_mt6gmbwa_oqajpr", "e2540fac4da3a878478cb694aec7b61d498d0c78"],
  ["fnd_mt6grtkq_08ny3r", null],
  ["fnd_mt6h8us4_tm1ft8", null],
  ["fnd_mt6h8uy2_q5lmta", null],
  ["fnd_mt6h8v4j_6hqpl2", null],
  ["fnd_mt6hkypz_nm5xix", "c678e104"],
  ["fnd_mt6hpba6_7bqnn1", null],
  ["fnd_mt6hpbam_wlas4k", null],
  ["fnd_mt6i7r1p_1xo2qh", null],
  ["fnd_mt6i7utw_utu7d9", null],
  ["fnd_mt6i7zc8_h3i1pr", "3a08e4f7cfa3d753708b339a3191ccdc983198f7"],
  ["fnd_mt6i83o7_vco023", "ee9acc41ef020c6757bd8b1eee3d049f0f64ac73"],
  ["fnd_mt6i8fd7_xriabg", null],
  ["fnd_mt6id2bd_yxdv3r", "647063294a0ce46e3c4c8c095b2e3a8f0d66fbb7"],
  ["fnd_mt6il84e_uz7sfc", "e09312985ae1e29b61cf1da8279441bb2c3af9b6"],
  ["fnd_mt6ivd1d_n5ue9v", "684792dea56f9cd40f239704350631c29809e591"],
  ["fnd_mt6j1xeu_89fmas", "dc9ecc1a5a1f6f440b2b60f1ec42da14e3ceeb8a"],
  ["fnd_mt6j2133_95m1mp", "bf15cbab0ae17b1337d085df8f13ca59e7ea220c"],
  ["fnd_mt6j2avg_ne1rcc", "914960d7ab70428397266fe8080371a913f983fd"],
  ["fnd_mt6j2li2_rrp3m0", "f32660848016e98ee95662b26efc799daf618ee0"],
  ["fnd_mt6njrkj_pa0rpu", null],
  ["fnd_mt6owepq_nisshr", "426847ee363e758ab9f274206d698f2d8ce5453c"],
  ["fnd_mt6r6w39_vvul18", null],
  ["fnd_mt7nxp48_3iyi13", null],
  ["fnd_mt7nyxa_dyn307", null],
  ["fnd_mt7nyxa_erp307", null],
  ["fnd_mt7nyxa_ns307", "2645d3e50faf98e66d1575653ac5745a7764e041"],
  ["fnd_mt7nyxa_odoo307", null],
  ["fnd_mt7nyxa_qbo307", null],
  ["fnd_mt7nyxa_tax307", "2645d3e50faf98e66d1575653ac5745a7764e041"],
  ["fnd_mt7nyxa_xero307", "9d99fac88f5952098af7897c048f4727c2f1974b"],
  ["fnd_mt7uqucr_7te09s", null],
  ["fnd_mt7wjef6_tlh4xk", null],
  ["fnd_mt7x08vi_q1kuuq", "a022ac5c0f696b57b3fc3b03d6d5aecc9d37bc31"],
  ["fnd_mt7zu8fr_gzdpny", null],
  ["fnd_mt8occ_ui01", "92de651a4712f6bf0eca07ad19c59cf1d0f94dc4"],
  ["fnd_mt93di5q_4g07x7", null],
  ["fnd_mt93dsl6_ochy6b", null],
  ["fnd_mt93faxj_2vbr1k", null],
  ["fnd_mt93fb51_3iaccv", null],
  ["fnd_mt93hv04_t1xux3", null],
  ["fnd_mt93iohg_a26kwz", "cd0659bbfc51937833b6b75af300c6a6f13146c7"],
  ["fnd_mt93j79j_acrww5", "0ec5420af5e4ceea35650cec74fc699d2093109f"],
  ["fnd_mt93jzsa_36nro8", null],
  ["fnd_mt93lh25_wx145a", "15e81ba261b10b9abd88f8a85336b72da6db6adf"],
  ["fnd_mt93m5lb_3vrafk", null],
  ["fnd_mt93ob2o_pnz86g", "902bc70f9632d81860bdd2355668e51a1c5518df"],
  ["fnd_mt93ob2x_ixgpcz", "0fc5da8f69fb5548cedc40f87e56d14046f43f52"],
  ["fnd_mt93pteg_2fhne7", null],
  ["fnd_mt93pxiv_30cszg", null],
  ["fnd_mt974m5b_s6z81c", "465c1a9ee37cba873a09d74f00a68aa61ddec15d"],
  ["fnd_mt975es6_as3mmv", "09c05d0319974ee42e5bbb87fcf2d10658791961"],
  ["fnd_mt975x0h_hinde1", "0e076599f077f8d25f8ddb1446fa869faa1e59bc"],
  ["fnd_mt977oxa_w3pnwn", null],
  ["fnd_mt977oxk_dzn7k5", null],
  ["fnd_mt9781uq_ddm8o1", "8bddf466f1080037bb83d00e0d8792d50cb77ead"],
  ["fnd_mt97a43q_tuucq4", null],
  ["fnd_mt97akg5_iah4ah", null],
  ["fnd_mt97bb77_p6ijgb", "9ee7191a5f2fea7177f9dfa84e4a6372c8075c0c"],
  ["fnd_mt97bw38_pefqic", null],
  ["fnd_mt97d1r9_d2c31r", null],
  ["fnd_mt97dd9k_xl8bc6", "7b4c663d360ea0a93839b34b4f8ddb8a7f46f971"],
  ["fnd_mt97dwj1_u541eg", null],
  ["fnd_mt97epm0_32deli", null],
  ["fnd_mt97fdby_7x8jj1", "0777424f6aa12c1dbf8cd54cb3cfffed958cae18"],
  ["fnd_mt97h07k_qq4zuu", null],
  ["fnd_mt97h8qg_bj7svd", "71b56dbdebd6a2e22293dffd0de35628b5c43b6c"],
  ["fnd_mt97hnl4_ishlfk", null],
  ["fnd_mt97i83j_cplh9f", null],
  ["fnd_mt97iykp_cijjod", null],
  ["fnd_mt97klqv_y5e7a4", null],
  ["fnd_mt97llmk_73ao2v", null],
  ["fnd_mt97mh7p_nr947m", null],
  ["fnd_mt97n01e_k0i905", "945692755a1dab707d4eafac97a9f1d766c6a630"],
  ["fnd_mt97nsbf_qvlaww", null],
  ["fnd_mt97oet5_3vwaph", null],
  ["fnd_mt97oqxt_pkqakx", null],
  ["fnd_mt97oymm_qendf1", "c6b2c583aea3f6069ed386d836afb385184743b0"],
  ["fnd_mt97pgkk_aqbv5k", null],
  ["fnd_mt97pvxg_d70tip", "971796005ae10845af3a9ac966ff68c249734c02"],
  ["fnd_mt97q2sv_gcq214", "971796005ae10845af3a9ac966ff68c249734c02"],
  ["fnd_mt97qyi2_wvv28m", "be24f5a157d61be9b484a509f49316d24f1670d9"],
  ["fnd_mt97qyp4_telk90", null],
  ["fnd_mt97r7dv_718clo", null],
  ["fnd_mt97ro32_l25fnb", null],
  ["fnd_mt97saah_g5t5gl", null],
  ["fnd_mt97szcp_4st3jw", "0fbac440f35b2ac73fe53b5d186c2d5fa24c0d9b"],
  ["fnd_mt97tia0_suyr0b", "9bce42f694be5b37122eceb48e81ce1872c98bbb"],
  ["fnd_mt97va1e_kiv9jd", null],
  ["fnd_mt97vtcu_qq1p6l", "42bc2dd724c2f20df840add9a7b7d8705d2ec73e"],
  ["fnd_mt97wk5r_6qlleu", "1c5d478ed84581634a764fa63cde388202f3e700"],
  ["fnd_mt97wkcv_xyihvs", "1c5d478ed84581634a764fa63cde388202f3e700"],
  ["fnd_mt97x354_95wuji", "e581adf429c64fa632a26a709101d286e28a2df2"],
  ["fnd_mt97xho6_9toxm3", null],
  ["fnd_mt97y4xt_j9cs76", null],
  ["fnd_mt97yzh2_g2elfn", "ba4225fbdd572a99f87066fb5e7e7b71ea084ff3"],
  ["fnd_mt97zkjh_foir2g", null],
  ["fnd_mt97zx1b_0of5w2", null],
  ["fnd_mt980nx1_8yu8k8", null],
  ["fnd_mt980yut_f4geph", null],
  ["fnd_mt981v1v_zf5ryu", "69b67969d7817290b695d527708e363a1faf8ba7"],
  ["fnd_mt9826j4_enjdzq", null],
  ["fnd_mt9835mh_4xjl6x", null],
  ["fnd_mt9844pt_0bwnsn", "0575704025ef5290927830c31db7ff5b771eb496"],
  ["fnd_mt9844xu_b1ncd4", "a0801f0476f53b99bc8ea7a85ab29b875a99fdd2"],
  ["fnd_mt985mgz_xcpku4", "dd5cafde4f5e2fde0876a2d52100c1f97a3a57ac"],
  ["fnd_mt985mo0_m1238j", null],
  ["fnd_mt985mvj_zd1ycd", null],
  ["fnd_mt986ixy_xr523b", null],
  ["fnd_mt986j4q_1gqfw3", null],
  ["fnd_mt98793o_lvc9gd", null],
  ["fnd_mt9882wo_l314gc", null],
  ["fnd_mt988344_b5doou", null],
  ["fnd_mt989eq2_n6ab9n", null],
  ["fnd_mt989eyk_d2o16j", null],
  ["fnd_mt989f5e_fvnt5n", null],
  ["fnd_mt989few_hnavpi", null],
  ["fnd_mt989v18_3b1g7c", null],
  ["fnd_mt989v9y_emu0nl", null],
  ["fnd_mt989vhl_v87x56", null],
  ["fnd_mt98ab70_kset3i", null],
  ["fnd_mt98b80x_wnkixr", null],
  ["fnd_mt98b89p_6red67", null],
  ["fnd_mt98ibos_56vpx3", null],
  ["fnd_mt98ibwk_qse6sn", null],
  ["fnd_mt98ic7n_pnikya", null],
  ["fnd_mt98icid_d7fais", null],
  ["fnd_mt98id5z_fm85s1", "74faf710e09bc5baaa3bc070db2d992bf7ff4ece"],
  ["fnd_mt98idd7_jc13bb", null],
  ["fnd_mt98mi5i_t6ggfb", null],
  ["fnd_mt98s1wr_pc4eoc", null],
  ["fnd_mt98x89g_rum8v4", null],
  ["fnd_mt98x8g4_ekti6y", null],
  ["fnd_mt98x8mi_n0xf0x", null],
  ["fnd_mt98ya8s_hpy390", null],
  ["fnd_mt98yafa_psuhup", null],
  ["fnd_mt98yalu_uxqtgs", null],
  ["fnd_mt98zmzh_yr5vfd", "3f729724f2c7c3809291ecf327aa68507d277b2d"],
  ["fnd_mt990eqc_pogusd", "ea24b850c4016dd9bed09f3fc2a2632063bab1dd"],
  ["fnd_mt9916hm_ks1v6m", null],
  ["fnd_mt992j6u_n8pf3s", null],
  ["fnd_mt997rlt_ey5x9l", "ef54cb7e8058178ff68ebcc1e8efd6544a13ed8b"],
  ["fnd_mt997rmv_jnbab2", null],
  ["fnd_mt997rn6_yoslw8", null],
  ["fnd_mt997rni_q9pxx9", null],
  ["fnd_mt997rns_lkzqdd", null],
  ["fnd_mt9994cg_7kdg3r", null],
  ["fnd_mt9994cm_p73ahi", null],
  ["fnd_mt99blp7_oc4wap", null],
  ["fnd_mt99c1fy_h1nd0m", null],
  ["fnd_mt99cjo5_v6e9fd", null],
  ["fnd_mt99lbdi_8g8z6t", null],
  ["fnd_mt99m1qt_tnmpxm", null],
  ["fnd_mt99uof2_s53uix", null],
  ["fnd_mt9b3c4h_zivx73", null],
  ["fnd_mt9cgsdf_w8rzgx", null],
  ["fnd_mt9ck222_msy30x", null],
  ["fnd_mt9ck2a5_rf7ofs", "dd5cafde4f5e2fde0876a2d52100c1f97a3a57ac"],
  ["fnd_mt9ck2hq_eto2wr", null],
  ["fnd_mt9ck2q4_23vdf7", null],
  ["fnd_mt9ck2y8_24zn12", null],
  ["fnd_mt9clkl3_99cjiw", null],
  ["fnd_mt9clktg_8emvie", null],
  ["fnd_mt9cllh4_rqoomf", null],
  ["fnd_mt9cllpq_nhoqpm", null],
  ["fnd_mt9f3evc_wfbtgw", null],
  ["fnd_mt9f3f3d_i49xeh", null],
  ["fnd_mt9f3fa9_8fnzy5", null],
  ["fnd_mt9f3fh4_gjhteu", "682f9abce32b666618cfccf647b1c34975827c37"],
  ["fnd_mt9f3fnu_tztsoy", null],
  ["fnd_mt9f3fun_4nrtx5", null],
  ["fnd_mt9fpr52_rw2w75", "58862ecc29c9747efe173d3ea39e8b1f6f4ed02b"],
  ["fnd_mt9fprbh_7xh58j", "7e37b2fab3ac4e262c552bfbb3cd61ffd0a7fcd9"],
  ["fnd_mt9fprht_sn2vu1", null],
  ["fnd_mt9fpro7_lkwt8h", "07d594ff10eda35af9484768c1ccb30c52d32858"],
  ["fnd_mt9fpruk_hgnxn4", "dd74ddf58a71f2c3ad97c01b7cf8e5a740cd5094"],
  ["fnd_mt9fps0x_cs9ajw", "7282ef15144bc50cae0df9a073a3a72517ab04fb"],
  ["fnd_mt9fps7a_pah0cu", "4e638a0490cd1b1361206e38df88624a7c13a3f4"],
  ["fnd_mt9fpsdi_73g32s", "92266c9e92426211981e04bb6b36147a02bd722f"],
  ["fnd_mt9fpsjw_hml958", "8b7572db97db4b6f1f06a2659a6938560666923f"],
  ["fnd_mt9fpsqk_xtbb78", null],
  ["fnd_mt9fsq8o_7wq7ou", "e7c5dca3ca22beb5eb59f5720a6e0680fb835ae7"],
  ["fnd_mt9fsqf6_5vb0ei", null],
  ["fnd_mt9g73e2_v569uh", "813763a24677965626f66d27e5e08762fb3ee9a2"],
  ["fnd_mt9g73kl_oiyxc9", "7264f708c6dd334719a0c05a1755b493c5372bb9"],
  ["fnd_mt9g73r2_4sq96c", "77090c7f2761d5e891ef2554be2cd0e093a562d1"],
  ["fnd_mt9g73xg_rxm7fn", "0680072480f2d8db5f9d9609cfe32a7090399fcf"],
  ["fnd_mt9g743u_w8y6mv", null],
  ["fnd_mt9g74ak_f6g1m2", "c57d40fe5b80221d26ad28faec2d3fa26eaaf681"],
  ["fnd_mt9g74gy_xp4y7b", null],
  ["fnd_mt9g74n9_uhjhvx", null],
  ["fnd_mt9g74tv_6m8ncl", "265b1ffcfd1e73b7be66a8842723cbd034472f68"],
  ["fnd_mt9g750l_bsy8hh", "ab02fd34cc895811e950d4d0fef25b6ed0d0cd4e"],
  ["fnd_mt9g7571_fwdt2r", null],
  ["fnd_mt9g8nwf_y9vc3f", "081fdd9886b919da740743381837a3cda8c2698f"],
  ["fnd_mt9gig7v_teva9z", null],
  ["fnd_mt9gixnn_u8i2at", null],
  ["fnd_mt9gtpt2_pnld8t", null],
  ["fnd_mt9gtq0t_aacpui", "38ef78a4471b74b3030a3725f7cd34953bc0b9a3"],
  ["fnd_mt9gtq9f_kpswno", "7583964fc637885336f1c9f84e2986bf3c692a22"],
  ["fnd_mt9gtqhu_de48jd", "15eed974d7f1c94360503742e27dd6998ef05d07"],
  ["fnd_mt9gtqp9_vtj7m6", null],
  ["fnd_mt9gtqwq_wtnaf0", "af7b3ca86832f9d63db845d013e2ee6961d72da3"],
  ["fnd_mt9gtr4l_3htnbj", null],
  ["fnd_mt9gtrbp_ex4076", "6a5e2a23a3f87f6247f983856d4c0fbb0ea583ae"],
  ["fnd_mt9hq5r0_7wffwa", "7264f708c6dd334719a0c05a1755b493c5372bb9"],
  ["fnd_mt9hq5zf_n0e5c1", null],
  ["fnd_mt9ivyyp_szb8nc", null],
  ["fnd_mt9jreit_487sxh", "7c15cc80bc4009647311180dc021f9f067a31738"],
  ["fnd_mt9jrpuy_4c7az9", null],
  ["fnd_mt9kule9_ow7ox1", "26744445ca04d077fd4f9c7f54bb1bf830e861b5"],
  ["fnd_mt9obj3a_s5rxb8", null],
  ["fnd_mt9q9e7u_816ci9", null],
  ["fnd_mta409jp_84yp5m", null],
  ["fnd_mta409tl_1ql1n7", "ea24b850c4016dd9bed09f3fc2a2632063bab1dd"],
  ["fnd_mta6nh7x_cieuh1", null],
  ["fnd_mta71cup_fzsshz", null],
  ["fnd_mta762au_h4x9l5", null],
  ["fnd_mta7fcxv_bfnlwv", "9504c826d946210e70d3568b4baf3c45b26e651f"],
  ["fnd_mta7fd1t_mg855e", null],
  ["fnd_mta7gbg0_9hmk5j", null],
  ["fnd_mta7znr6_wxtqxm", null],
  ["fnd_mtag3i7k_0aad7r", null],
  ["fnd_mtag55cv_zpbhuy", "2c8a8a5099bef0f54e5610e93fda94c93cac6dd1"],
  ["fnd_mtag5x4l_juwaxq", null],
  ["fnd_mtag6otw_a95aw6", null],
  ["fnd_mtag7vgy_7kbl45", "f274430e17e57bef915be710cf22b58c90a89d79"],
  ["fnd_mtah7rmu_bbciky", null],
  ["fnd_mtaimv2s_8iumm3", null],
  ["fnd_mtain7xv_n6lbj3", null],
  ["fnd_mtbnparb_fnvdqh", "13760657c69081f142bfefa55d0f76599e93839e"],
  ["fnd_mtbnpxsd_9e8npy", null],
  ["fnd_mtbnqgz1_n95clg", "29b3ae3d21809a6709cb3ff7a4433813e8a7d925"],
  ["fnd_mtbnqpsu_xt0hrx", null],
  ["fnd_mtbnrwxh_xuh8t0", "f290dd32a5ba80acd003ef8bb24664f4cd9af14c"],
];

/**
 * Historical baseline metadata: [finding id, class]. Each entry names a
 * finding recorded fixed whose fix was NOT verifiably reachable from the
 * integration ref on 2026-08-27. These entries remain useful for class-drift
 * diagnostics, but auditRegister treats them as violations; history gaps are
 * never silently waived by retaining a baseline row.
 */
const BASELINE_DATA = [
  ["fnd_018b450d_de435b", "unattributed"],
  ["fnd_040063a6_6655aa", "unattributed"],
  ["fnd_04e41fe5_f3f613", "unattributed"],
  ["fnd_08d314af_52afcb", "unattributed"],
  ["fnd_0fc81515_37cfa1", "unattributed"],
  ["fnd_0fed3e7a_e45285", "unattributed"],
  ["fnd_10e62337_1cdaaa", "unattributed"],
  ["fnd_1440f766_cf9756", "unattributed"],
  ["fnd_192456a6_f4f910", "unattributed"],
  ["fnd_1d1c9297_cfe976", "unattributed"],
  ["fnd_26619e5e_9457b9", "unattributed"],
  ["fnd_2872f07a_1f0993", "unattributed"],
  ["fnd_2aa931e8_1c94f7", "unattributed"],
  ["fnd_2b50a6e1_c3cade", "unattributed"],
  ["fnd_2b93f017_665325", "unattributed"],
  ["fnd_3b65cf28_ffcb7e", "unattributed"],
  ["fnd_3c97b269_8b257e", "unattributed"],
  ["fnd_3e38f9d1_e2ae4b", "unattributed"],
  ["fnd_461bea26_8fd15a", "unattributed"],
  ["fnd_4992e18b_9c685c", "unattributed"],
  ["fnd_4afdaaca_5dfa95", "unattributed"],
  ["fnd_4c6c59ff_a21e0f", "unattributed"],
  ["fnd_4d319df5_30400e", "unattributed"],
  ["fnd_510b1782_bd65b3", "unattributed"],
  ["fnd_574198e6_08be98", "unattributed"],
  ["fnd_59993902_1dc251", "unattributed"],
  ["fnd_644008a8_9963bb", "unattributed"],
  ["fnd_6827600b_ef565e", "unattributed"],
  ["fnd_6844af5a_14f5da", "unattributed"],
  ["fnd_68f990dd_e5cb20", "unattributed"],
  ["fnd_697c3d37_3a32b2", "unattributed"],
  ["fnd_6a8c6921_9ffdd4", "unattributed"],
  ["fnd_6acd3c58_1e7df0", "unattributed"],
  ["fnd_6cf09ba6_c05581", "unattributed"],
  ["fnd_7319e252_0a39a5", "unattributed"],
  ["fnd_7c110457_f37fef", "unattributed"],
  ["fnd_7c402f33_7ec766", "unattributed"],
  ["fnd_7f4b9165_04c3da", "unattributed"],
  ["fnd_7f75a7e7_aed241", "unattributed"],
  ["fnd_80b3dc55_db2f1f", "unattributed"],
  ["fnd_80c456a3_09a85f", "unattributed"],
  ["fnd_84077a9c_bc371b", "unattributed"],
  ["fnd_844e9c12_cc86f3", "unattributed"],
  ["fnd_85323ce2_4f0c4b", "unattributed"],
  ["fnd_8af1095c_af50d5", "unattributed"],
  ["fnd_8ee4529a_4b560d", "unattributed"],
  ["fnd_9251a1a4_f53bbb", "unattributed"],
  ["fnd_9435bc25_c0b8f4", "unattributed"],
  ["fnd_94d974c9_ed9a07", "unattributed"],
  ["fnd_97fba149_c7beae", "unattributed"],
  ["fnd_99db4bea_12141a", "unattributed"],
  ["fnd_a11ac2c2_e6ce78", "unattributed"],
  ["fnd_a21eac3e_210929", "unattributed"],
  ["fnd_a4b43519_7b313e", "unattributed"],
  ["fnd_ab9deb28_991520", "unattributed"],
  ["fnd_ac6c98cb_72cebe", "unattributed"],
  ["fnd_adbfd70d_36bf98", "unattributed"],
  ["fnd_af606d75_d64ab4", "unattributed"],
  ["fnd_au_gatesratchet", "unattributed"],
  ["fnd_b03b93e1_ada036", "unattributed"],
  ["fnd_b320d624_cb733c", "unattributed"],
  ["fnd_b36ecd91_bbf47a", "unattributed"],
  ["fnd_b521df02_f74e00", "unattributed"],
  ["fnd_bccf46e8_f3ef1d", "unattributed"],
  ["fnd_c0c56289_3e5981", "unattributed"],
  ["fnd_c72cb529_73b9de", "unattributed"],
  ["fnd_c98f837c_cd1176", "unattributed"],
  ["fnd_caf101af_c15701", "unattributed"],
  ["fnd_cc6d57b7_d8dd01", "unattributed"],
  ["fnd_d2321082_57cf9c", "unattributed"],
  ["fnd_d903ce80_f886d7", "unattributed"],
  ["fnd_da3b2b0e_ba22fe", "unattributed"],
  ["fnd_da55a18b_4ca29f", "unattributed"],
  ["fnd_dc0ca0a5_885180", "unattributed"],
  ["fnd_df8faf6c_3e052f", "unattributed"],
  ["fnd_ebb5fa58_3db60e", "unattributed"],
  ["fnd_f1a324e5_c23f05", "unattributed"],
  ["fnd_f1c01a19_80c40d", "unattributed"],
  ["fnd_f6d05c34_122968", "unattributed"],
  ["fnd_f791d71e_479414", "unattributed"],
  ["fnd_f8e9e947_e7856a", "unattributed"],
  ["fnd_faf08cc6_bd0ff0", "unattributed"],
  ["fnd_fb3f8a2f_3a6074", "unattributed"],
  ["fnd_ff21970a_73f04b", "unattributed"],
  ["fnd_ff47a174_c9b691", "unattributed"],
  ["fnd_mt6g89d5_7irug4", "unattributed"],
  ["fnd_mt6g89oj_cpk530", "unattributed"],
  ["fnd_mt6gk4yo_sh9m3d", "unattributed"],
  ["fnd_mt6grtkq_08ny3r", "unattributed"],
  ["fnd_mt6h8us4_tm1ft8", "unattributed"],
  ["fnd_mt6h8uy2_q5lmta", "unattributed"],
  ["fnd_mt6h8v4j_6hqpl2", "unattributed"],
  ["fnd_mt6hpba6_7bqnn1", "unattributed"],
  ["fnd_mt6hpbam_wlas4k", "unattributed"],
  ["fnd_mt6i7r1p_1xo2qh", "unattributed"],
  ["fnd_mt6i7utw_utu7d9", "unattributed"],
  ["fnd_mt6i8fd7_xriabg", "unattributed"],
  ["fnd_mt6njrkj_pa0rpu", "unattributed"],
  ["fnd_mt6r6w39_vvul18", "unattributed"],
  ["fnd_mt7nxp48_3iyi13", "unattributed"],
  ["fnd_mt7nyxa_dyn307", "unattributed"],
  ["fnd_mt7nyxa_erp307", "unattributed"],
  ["fnd_mt7nyxa_odoo307", "unattributed"],
  ["fnd_mt7nyxa_qbo307", "unattributed"],
  ["fnd_mt7uqucr_7te09s", "unattributed"],
  ["fnd_mt7wjef6_tlh4xk", "unattributed"],
  ["fnd_mt7zu8fr_gzdpny", "unattributed"],
  ["fnd_mt93di5q_4g07x7", "unattributed"],
  ["fnd_mt93dsl6_ochy6b", "unattributed"],
  ["fnd_mt93faxj_2vbr1k", "unattributed"],
  ["fnd_mt93fb51_3iaccv", "unattributed"],
  ["fnd_mt93hv04_t1xux3", "unattributed"],
  ["fnd_mt93jzsa_36nro8", "unattributed"],
  ["fnd_mt93m5lb_3vrafk", "unattributed"],
  ["fnd_mt93pteg_2fhne7", "unattributed"],
  ["fnd_mt93pxiv_30cszg", "unattributed"],
  ["fnd_mt977oxa_w3pnwn", "unattributed"],
  ["fnd_mt977oxk_dzn7k5", "unattributed"],
  ["fnd_mt97a43q_tuucq4", "unattributed"],
  ["fnd_mt97akg5_iah4ah", "unattributed"],
  ["fnd_mt97bw38_pefqic", "unattributed"],
  ["fnd_mt97d1r9_d2c31r", "unattributed"],
  ["fnd_mt97dwj1_u541eg", "unattributed"],
  ["fnd_mt97epm0_32deli", "unattributed"],
  ["fnd_mt97h07k_qq4zuu", "unattributed"],
  ["fnd_mt97hnl4_ishlfk", "unattributed"],
  ["fnd_mt97i83j_cplh9f", "unattributed"],
  ["fnd_mt97iykp_cijjod", "unattributed"],
  ["fnd_mt97klqv_y5e7a4", "unattributed"],
  ["fnd_mt97llmk_73ao2v", "unattributed"],
  ["fnd_mt97mh7p_nr947m", "unattributed"],
  ["fnd_mt97nsbf_qvlaww", "unattributed"],
  ["fnd_mt97oet5_3vwaph", "unattributed"],
  ["fnd_mt97oqxt_pkqakx", "unattributed"],
  ["fnd_mt97pgkk_aqbv5k", "unattributed"],
  ["fnd_mt97qyp4_telk90", "unattributed"],
  ["fnd_mt97r7dv_718clo", "unattributed"],
  ["fnd_mt97ro32_l25fnb", "unattributed"],
  ["fnd_mt97saah_g5t5gl", "unattributed"],
  ["fnd_mt97va1e_kiv9jd", "unattributed"],
  ["fnd_mt97xho6_9toxm3", "unattributed"],
  ["fnd_mt97y4xt_j9cs76", "unattributed"],
  ["fnd_mt97zkjh_foir2g", "unattributed"],
  ["fnd_mt97zx1b_0of5w2", "unattributed"],
  ["fnd_mt980nx1_8yu8k8", "unattributed"],
  ["fnd_mt980yut_f4geph", "unattributed"],
  ["fnd_mt9826j4_enjdzq", "unattributed"],
  ["fnd_mt9835mh_4xjl6x", "unattributed"],
  ["fnd_mt985mo0_m1238j", "unattributed"],
  ["fnd_mt985mvj_zd1ycd", "unattributed"],
  ["fnd_mt986ixy_xr523b", "unattributed"],
  ["fnd_mt986j4q_1gqfw3", "unattributed"],
  ["fnd_mt98793o_lvc9gd", "unattributed"],
  ["fnd_mt9882wo_l314gc", "unattributed"],
  ["fnd_mt988344_b5doou", "unattributed"],
  ["fnd_mt989eq2_n6ab9n", "unattributed"],
  ["fnd_mt989eyk_d2o16j", "unattributed"],
  ["fnd_mt989f5e_fvnt5n", "unattributed"],
  ["fnd_mt989few_hnavpi", "unattributed"],
  ["fnd_mt989v18_3b1g7c", "unattributed"],
  ["fnd_mt989v9y_emu0nl", "unattributed"],
  ["fnd_mt989vhl_v87x56", "unattributed"],
  ["fnd_mt98ab70_kset3i", "unattributed"],
  ["fnd_mt98b80x_wnkixr", "unattributed"],
  ["fnd_mt98b89p_6red67", "unattributed"],
  ["fnd_mt98ibos_56vpx3", "unattributed"],
  ["fnd_mt98ibwk_qse6sn", "unattributed"],
  ["fnd_mt98ic7n_pnikya", "unattributed"],
  ["fnd_mt98icid_d7fais", "unattributed"],
  ["fnd_mt98idd7_jc13bb", "unattributed"],
  ["fnd_mt98mi5i_t6ggfb", "unattributed"],
  ["fnd_mt98s1wr_pc4eoc", "unattributed"],
  ["fnd_mt98x89g_rum8v4", "unattributed"],
  ["fnd_mt98x8g4_ekti6y", "unattributed"],
  ["fnd_mt98x8mi_n0xf0x", "unattributed"],
  ["fnd_mt98ya8s_hpy390", "unattributed"],
  ["fnd_mt98yafa_psuhup", "unattributed"],
  ["fnd_mt98yalu_uxqtgs", "unattributed"],
  ["fnd_mt9916hm_ks1v6m", "unattributed"],
  ["fnd_mt992j6u_n8pf3s", "unattributed"],
  ["fnd_mt997rmv_jnbab2", "unattributed"],
  ["fnd_mt997rn6_yoslw8", "unattributed"],
  ["fnd_mt997rni_q9pxx9", "unattributed"],
  ["fnd_mt997rns_lkzqdd", "unattributed"],
  ["fnd_mt9994cg_7kdg3r", "unattributed"],
  ["fnd_mt9994cm_p73ahi", "unattributed"],
  ["fnd_mt99blp7_oc4wap", "unattributed"],
  ["fnd_mt99c1fy_h1nd0m", "unattributed"],
  ["fnd_mt99cjo5_v6e9fd", "unattributed"],
  ["fnd_mt99lbdi_8g8z6t", "unattributed"],
  ["fnd_mt99m1qt_tnmpxm", "unattributed"],
  ["fnd_mt99uof2_s53uix", "unattributed"],
  ["fnd_mt9b3c4h_zivx73", "unattributed"],
  ["fnd_mt9cgsdf_w8rzgx", "unattributed"],
  ["fnd_mt9ck222_msy30x", "unattributed"],
  ["fnd_mt9ck2hq_eto2wr", "unattributed"],
  ["fnd_mt9ck2q4_23vdf7", "unattributed"],
  ["fnd_mt9ck2y8_24zn12", "unattributed"],
  ["fnd_mt9clkl3_99cjiw", "unattributed"],
  ["fnd_mt9clktg_8emvie", "unattributed"],
  ["fnd_mt9cllh4_rqoomf", "unattributed"],
  ["fnd_mt9cllpq_nhoqpm", "unattributed"],
  ["fnd_mt9f3evc_wfbtgw", "unattributed"],
  ["fnd_mt9f3f3d_i49xeh", "unattributed"],
  ["fnd_mt9f3fa9_8fnzy5", "unattributed"],
  ["fnd_mt9f3fnu_tztsoy", "unattributed"],
  ["fnd_mt9f3fun_4nrtx5", "unattributed"],
  ["fnd_mt9fprht_sn2vu1", "unattributed"],
  ["fnd_mt9fpsqk_xtbb78", "unattributed"],
  ["fnd_mt9fsqf6_5vb0ei", "unattributed"],
  ["fnd_mt9g743u_w8y6mv", "unattributed"],
  ["fnd_mt9g74gy_xp4y7b", "unattributed"],
  ["fnd_mt9g74n9_uhjhvx", "unattributed"],
  ["fnd_mt9g7571_fwdt2r", "unattributed"],
  ["fnd_mt9gig7v_teva9z", "unattributed"],
  ["fnd_mt9gixnn_u8i2at", "unattributed"],
  ["fnd_mt9gtpt2_pnld8t", "unattributed"],
  ["fnd_mt9gtqp9_vtj7m6", "unattributed"],
  ["fnd_mt9gtr4l_3htnbj", "unattributed"],
  ["fnd_mt9ivyyp_szb8nc", "unattributed"],
  ["fnd_mt9jrpuy_4c7az9", "unattributed"],
  ["fnd_mt9obj3a_s5rxb8", "unattributed"],
  ["fnd_mt9q9e7u_816ci9", "unattributed"],
  ["fnd_mta409jp_84yp5m", "unattributed"],
  ["fnd_mta6nh7x_cieuh1", "unattributed"],
  ["fnd_mta71cup_fzsshz", "unattributed"],
  ["fnd_mta762au_h4x9l5", "unattributed"],
  ["fnd_mta7fd1t_mg855e", "unattributed"],
  ["fnd_mta7gbg0_9hmk5j", "unattributed"],
  ["fnd_mta7znr6_wxtqxm", "unattributed"],
  ["fnd_mtag3i7k_0aad7r", "unattributed"],
  ["fnd_mtag5x4l_juwaxq", "unattributed"],
  ["fnd_mtag6otw_a95aw6", "unattributed"],
  ["fnd_mtah7rmu_bbciky", "unattributed"],
  ["fnd_mtaimv2s_8iumm3", "unattributed"],
  ["fnd_mtain7xv_n6lbj3", "unattributed"],
  ["fnd_mtbnpxsd_9e8npy", "unattributed"],
  ["fnd_mtbnqpsu_xt0hrx", "unattributed"],
  ["fnd_mt9hq5zf_n0e5c1", "unattributed"],
  ["fnd_24dfd85d_ff16d2", "unreachable"],
  ["fnd_421d5f16_2b6657", "unreachable"],
  ["fnd_56e2f1d3_73d494", "unreachable"],
  ["fnd_6a5d52fa_a5a3a0", "unreachable"],
  ["fnd_815b6d7d_de3a32", "unreachable"],
  ["fnd_82904c62_85f4ed", "unreachable"],
  ["fnd_84a1dbbb_832e7c", "unreachable"],
  ["fnd_8ae2ccb8_9a2063", "unreachable"],
  ["fnd_8af82a06_e94d88", "unreachable"],
  ["fnd_d3eb5d98_28c85a", "unreachable"],
  ["fnd_d46f1bdf_6db94a", "unreachable"],
  ["fnd_ddae2dd2_92aed7", "unreachable"],
  ["fnd_f3336505_de4203", "unreachable"],
  ["fnd_f40ce24a_881fae", "unreachable"],
  ["fnd_mt7nyxa_ns307", "unreachable"],
  ["fnd_mt7nyxa_tax307", "unreachable"],
  ["fnd_mt9844pt_0bwnsn", "unreachable"],
  ["fnd_mtbnparb_fnvdqh", "unreachable"],
  ["fnd_mt6g89ug_ggc4yz", "unresolvable"],
  ["fnd_mt6g8a0w_5o5636", "unresolvable"],
  ["fnd_mt6gfs13_ujfk0k", "unresolvable"],
  ["fnd_mt6gkn8t_v39f6j", "unresolvable"],
  ["fnd_mt6gmbvt_y36mdn", "unresolvable"],
  ["fnd_mt6gmbwa_oqajpr", "unresolvable"],
  ["fnd_mt6hkypz_nm5xix", "unresolvable"],
  ["fnd_mt6id2bd_yxdv3r", "unresolvable"],
  ["fnd_mt6j1xeu_89fmas", "unresolvable"],
  ["fnd_mt6j2133_95m1mp", "unresolvable"],
];

export const REGISTER = new Map(REGISTER_DATA);
export const BASELINE = new Map(BASELINE_DATA);
export { CHECK_REF, BASELINE_DATE };

/**
 * Parse an externally supplied register without weakening the checked-in
 * fallback. The BB register lives in the ultragoal SQLite store, while CI
 * jobs can pass an exported JSON document; both sources are deliberately
 * opt-in so a normal clone remains dependency-free. Rows with a status field
 * are restricted to findings recorded fixed or resolved.
 */
function parseLiveRegister(value, source) {
  let rows = value;
  if (rows && !Array.isArray(rows) && typeof rows === "object") {
    rows = rows.findings || rows.register || rows.rows;
  }
  if (!Array.isArray(rows)) throw new Error(`${source} must contain a findings array`);

  const parsed = [];
  const seen = new Set();
  for (const row of rows) {
    const id = Array.isArray(row) ? row[0] : row?.id || row?.findingId || row?.finding_id;
    const status = Array.isArray(row) ? null : row?.status;
    if (status && status !== "fixed" && status !== "resolved") continue;
    if (typeof id !== "string" || !/^fnd_[a-z0-9_]+$/.test(id)) {
      throw new Error(`${source} contains an invalid finding id`);
    }
    if (seen.has(id)) throw new Error(`${source} contains duplicate finding ${id}`);
    seen.add(id);

    const ref = Array.isArray(row)
      ? row[1] ?? null
      : row?.closingCommit ??
        row?.closingRef ??
        row?.closing_ref ??
        row?.commitSha ??
        row?.commit_sha ??
        row?.ref ??
        null;
    if (ref !== null && (typeof ref !== "string" || !/^[0-9a-f]{7,40}$/.test(ref))) {
      throw new Error(`${source} has an invalid closing ref for ${id}`);
    }
    parsed.push([id, ref]);
  }
  if (parsed.length === 0) throw new Error(`${source} contains no fixed or resolved findings`);
  return new Map(parsed);
}

function refFromResolutionNote(note) {
  if (typeof note !== "string") return null;
  // Verification notes conventionally say "Commit <sha>" or "HEAD <sha>".
  // Prefer those labels so a base commit mentioned later cannot be mistaken
  // for the fix; fall back to the first standalone commit token.
  const labelled = note.match(/\b(?:commit|head|sha)\s+([0-9a-f]{7,40})\b/i);
  if (labelled) return labelled[1];
  return note.match(/\b[0-9a-f]{7,40}\b/i)?.[0] || null;
}

function liveRegisterFromJson() {
  let raw;
  try {
    raw = existsSync(LIVE_REGISTER_JSON) ? readFileSync(LIVE_REGISTER_JSON, "utf8") : LIVE_REGISTER_JSON;
    return parseLiveRegister(JSON.parse(raw), "OPENBOOKS_REGISTER_JSON");
  } catch (error) {
    throw new Error(`cannot load OPENBOOKS_REGISTER_JSON: ${error.message}`);
  }
}

function liveRegisterFromDatabase() {
  const threadPredicate = LIVE_REGISTER_THREAD
    ? `AND f.thread_id = '${LIVE_REGISTER_THREAD.replace(/'/g, "''")}'`
    : "AND f.thread_id = (SELECT thread_id FROM goals ORDER BY updated_at DESC LIMIT 1)";
  const query = `
    SELECT f.id, f.status, f.resolution_note,
      (SELECT i.commit_sha FROM goal_item_integrations i
        WHERE i.thread_id = f.thread_id AND i.item_id = f.item_id AND i.commit_sha IS NOT NULL
        ORDER BY i.recorded_at DESC LIMIT 1) AS integration_commit
    FROM goal_findings f
    WHERE f.status IN ('fixed', 'resolved') ${threadPredicate}
    ORDER BY f.id;
  `;
  try {
    const raw = execFileSync("sqlite3", ["-readonly", "-json", LIVE_REGISTER_DB, query], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const rows = JSON.parse(raw || "[]").map((row) => ({
      id: row.id,
      status: row.status,
      closing_ref: row.integration_commit || refFromResolutionNote(row.resolution_note),
    }));
    return parseLiveRegister(rows, `OPENBOOKS_REGISTER_DB (${LIVE_REGISTER_DB})`);
  } catch (error) {
    throw new Error(`cannot load OPENBOOKS_REGISTER_DB: ${error.message}`);
  }
}

function loadRegister() {
  if (LIVE_REGISTER_JSON && LIVE_REGISTER_DB) {
    throw new Error("set only one of OPENBOOKS_REGISTER_JSON or OPENBOOKS_REGISTER_DB for a campaign audit");
  }
  if (LIVE_REGISTER_JSON) return liveRegisterFromJson();
  if (LIVE_REGISTER_DB) return liveRegisterFromDatabase();
  return REGISTER;
}

/**
 * Scope historical metadata to the exact register cohort being audited.
 *
 * The checked-in baseline is a campaign snapshot, while live JSON/SQLite
 * probes can contain a newer or narrower goal register. The loaded register
 * is authoritative for that run; baseline rows outside its ID set are stale
 * metadata from another cohort and must not become bogus "no register entry"
 * violations. Rows in the cohort remain strict: auditRegister still treats
 * known gaps as failures and emits them in IRREDUCIBLE_REGISTER_ROWS_JSON.
 */
export function scopeBaselineToRegister(register, baseline = BASELINE) {
  const cohort = new Set(register.keys());
  return new Map([...baseline].filter(([id]) => cohort.has(id)));
}

function loadCampaign() {
  const register = loadRegister();
  return {
    register,
    baseline: scopeBaselineToRegister(register),
  };
}

/**
 * Classify every register entry against the tree. resolveRef maps a
 * reported ref to its commit sha (null when the object is absent from this
 * clone); isAncestor reports whether a resolved sha is an ancestor of the
 * check ref; isEquivalent reports truthy for a squash-equivalent patch (or
 * null when no equivalent patch exists); partial marks a checkout
 * that cannot resolve historical objects (shallow CI) — unverifiable entries
 * there are reported, never silently trusted or failed.
 */
export function auditRegister({ register, baseline, resolveRef, isAncestor, isEquivalent = () => null, checkRef = CHECK_REF, partial = false }) {
  const integrity = [];
  const seen = new Set();
  for (const [id] of register) {
    if (seen.has(id)) integrity.push(`${id}: duplicate register entry`);
    seen.add(id);
  }
  const bogusBaseline = [];
  for (const [id, entryClass] of baseline) {
    if (!BASELINE_CLASSES.has(entryClass)) {
      integrity.push(`${id}: baseline class "${entryClass}" is not one of ${[...BASELINE_CLASSES].join("/")}`);
    } else if (!register.has(id)) {
      bogusBaseline.push(`${id}: baseline entry names no register entry`);
    }
  }

  const counts = { reachable: 0, unreachable: 0, unresolvable: 0, unattributed: 0, unverifiable: 0 };
  const knownGaps = [];
  const staleBaseline = [];
  const classDrift = [];
  const newDrift = [];

  for (const [id, ref] of register) {
    if (!ref) {
      counts.unattributed += 1;
      const baselinedAs = baseline.get(id);
      if (baselinedAs === "unattributed") {
        knownGaps.push({ id, entryClass: "unattributed", detail: "no closing commit or branch was recorded" });
      } else if (baselinedAs) {
        classDrift.push({ id, was: baselinedAs, now: "unattributed", detail: "baseline class contradicts the register — reconcile" });
      } else {
        newDrift.push({ id, entryClass: "unattributed", detail: "recorded fixed with no closing commit or branch" });
      }
      continue;
    }
    const sha = resolveRef(ref);
    if (!sha) {
      if (partial) {
        counts.unverifiable += 1;
        continue;
      }
      counts.unresolvable += 1;
      const baselinedAs = baseline.get(id);
      const detail = `reported closing ref ${ref} is not a commit object in this repository`;
      if (baselinedAs === "unresolvable") {
        knownGaps.push({ id, entryClass: "unresolvable", detail });
      } else if (baselinedAs) {
        classDrift.push({ id, was: baselinedAs, now: "unresolvable", detail });
      } else {
        newDrift.push({ id, entryClass: "unresolvable", detail });
      }
      continue;
    }
    const ancestor = isAncestor(sha);
    // A shallow clone cannot prove that a non-ancestor is absent from the
    // full history. Do not let a truncated rev-list turn a valid historical
    // fix into a false unreachable violation.
    if (partial && !ancestor) {
      counts.unverifiable += 1;
      continue;
    }
    const equivalentSha = ancestor ? null : isEquivalent(sha);
    if (ancestor || equivalentSha) {
      counts.reachable += 1;
      if (baseline.has(id)) {
        const detail = equivalentSha
          ? `closing commit ${sha.slice(0, 8)} has a squash-equivalent patch on ${checkRef} — remove from baseline`
          : `closing commit ${sha.slice(0, 8)} is now reachable from ${checkRef} — remove from baseline`;
        staleBaseline.push({ id, ref: sha.slice(0, 8), was: baseline.get(id), detail });
      }
      continue;
    }
    counts.unreachable += 1;
    const baselinedAs = baseline.get(id);
    const detail = `closing commit ${sha.slice(0, 8)} is not an ancestor or squash-equivalent of ${checkRef}`;
    if (baselinedAs === "unreachable") {
      knownGaps.push({ id, entryClass: "unreachable", detail });
    } else if (baselinedAs) {
      classDrift.push({ id, was: baselinedAs, now: "unreachable", detail });
    } else {
      newDrift.push({ id, entryClass: "unreachable", detail });
    }
  }

  return { counts, knownGaps, staleBaseline, classDrift, newDrift, integrity, bogusBaseline };
}

function git(...args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function resolveCommit(ref) {
  try {
    return git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Ask git's deterministic patch-id comparison whether a reported commit was
 * replayed on ref (normally by a squash merge). `git cherry` compares patches,
 * not metadata, and its `-` marker means the commit's patch already exists on
 * the upstream ref. Exact ancestry is checked separately and always wins.
 */
function isPatchEquivalent(ref, upstreamRef) {
  try {
    const lines = git("cherry", "-v", upstreamRef, ref).trim().split("\n");
    return lines.some((line) => line.startsWith("- ") && line.split(/\s+/, 3)[1] === ref);
  } catch {
    return false;
  }
}

/**
 * Preserve the evidence trail for rows that remain unsupported. A null
 * register ref is not silently promoted from a similarly named worker branch:
 * branch and subject searches are recorded as attempted sources, while only
 * exact ancestry or deterministic patch-id equivalence can mark a row
 * reachable. The result is emitted as one JSON record so CI and remediation
 * tooling can consume the irreducible set without scraping prose.
 */
function collectAttributionEvidence({ register, checkRef, ancestors, equivalentCommits, shallow }) {
  const refs = git("for-each-ref", "--format=%(refname)").split("\n").filter(Boolean);
  const subjects = git("log", "--all", "--format=%H%x09%s", "--no-decorate")
    .split("\n")
    .map((line) => {
      const separator = line.indexOf("\t");
      return separator < 0 ? null : { sha: line.slice(0, separator), subject: line.slice(separator + 1) };
    })
    .filter(Boolean);
  const branchStatus = new Map();
  const statusForBranch = (ref) => {
    if (branchStatus.has(ref)) return branchStatus.get(ref);
    const tip = resolveCommit(ref);
    const exactAncestor = Boolean(tip && ancestors.has(tip));
    const patchEquivalent = Boolean(
      tip && !exactAncestor && !shallow && (equivalentCommits.has(tip) || isPatchEquivalent(tip, checkRef)),
    );
    const status = { ref, tip, exactAncestor, patchEquivalent };
    branchStatus.set(ref, status);
    return status;
  };

  const evidence = new Map();
  for (const [id, reportedRef] of register) {
    const stem = id.split("_")[1];
    const matchingBranches = refs
      .filter((ref) => ref.includes(id) || ref.includes(`itm-${stem}-`))
      .map(statusForBranch);
    const matchingSubjects = subjects.filter(({ subject }) => subject.includes(id));
    const resolvedSha = reportedRef ? resolveCommit(reportedRef) : null;
    const exactAncestor = Boolean(resolvedSha && ancestors.has(resolvedSha));
    const patchEquivalent = Boolean(resolvedSha && equivalentCommits.has(resolvedSha));
    const attemptedSources = [];
    if (reportedRef) attemptedSources.push("register-closing-ref");
    else attemptedSources.push("register-attribution");
    if (resolvedSha) attemptedSources.push("active-ref-ancestry");
    if (resolvedSha && !exactAncestor && !shallow) attemptedSources.push("deterministic-patch-id");
    if (matchingBranches.length > 0) attemptedSources.push("matching-branch-ref");
    if (matchingSubjects.length > 0) attemptedSources.push("matching-commit-subject");
    evidence.set(id, {
      reportedRef,
      resolvedSha,
      exactAncestor,
      patchEquivalent,
      attemptedSources,
      matchingBranches,
      matchingSubjects,
    });
  }
  return evidence;
}

function irreducibleRows(result, evidenceById, checkRef) {
  const rows = [...result.newDrift, ...result.knownGaps, ...result.classDrift];
  return rows.map((entry) => ({
    id: entry.id,
    category: entry.entryClass || entry.now,
    detail: entry.detail,
    checkRef,
    evidence: evidenceById.get(entry.id) || null,
  }));
}

function selectCheckRef() {
  return CHECK_REF;
}

function main() {
  let campaign;
  try {
    campaign = loadCampaign();
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const { register, baseline } = campaign;
  const checkRef = selectCheckRef();
  let shallow = false;
  try {
    shallow = git("rev-parse", "--is-shallow-repository").trim() === "true";
  } catch {
    console.error(`FAIL: git is unavailable, so the register cannot be checked against ${checkRef}.`);
    process.exitCode = 1;
    return;
  }

  const mainSha = resolveCommit(checkRef);
  if (!mainSha) {
    if (REQUESTED_REF) {
      console.error(
        `FAIL: OPENBOOKS_REGISTER_CHECK_REF=${checkRef} does not resolve to a commit in this repository.`,
      );
      process.exitCode = 1;
      return;
    }
    if (shallow) {
      console.log(
        `PARTIAL PASS: this shallow checkout has no ${checkRef} ref, so 0/${register.size} register entries ` +
          `could be verified against the tree. Re-run with complete history for the real gate.`,
      );
      return;
    }
    console.error(`FAIL: cannot resolve ${checkRef} in a complete checkout — the register's contract ref is missing.`);
    process.exitCode = 1;
    return;
  }

  // Ancestors of the check ref, computed once: rev-list is the exact
  // ancestry relation, and one pass beats one merge-base walk per entry.
  const ancestors = new Set(git("rev-list", checkRef).split("\n").filter(Boolean));
  const equivalentCommits = new Set();
  if (!shallow) {
    for (const [, ref] of register) {
      if (!ref) continue;
      const sha = resolveCommit(ref);
      if (!sha || ancestors.has(sha)) continue;
      if (isPatchEquivalent(sha, checkRef)) equivalentCommits.add(sha);
    }
  }
  const evidenceById = collectAttributionEvidence({
    register,
    checkRef,
    ancestors,
    equivalentCommits,
    shallow,
  });
  const result = auditRegister({
    register,
    baseline,
    resolveRef: resolveCommit,
    isAncestor: (sha) => ancestors.has(sha),
    isEquivalent: (sha) => (equivalentCommits.has(sha) ? true : null),
    checkRef,
    partial: shallow,
  });

  const { counts } = result;
  const violations =
    result.newDrift.length +
    result.knownGaps.length +
    result.staleBaseline.length +
    result.classDrift.length +
    result.integrity.length +
    result.bogusBaseline.length;

  if (violations > 0) {
    if (result.integrity.length > 0) {
      console.error("FAIL: register integrity errors:");
      for (const line of result.integrity) console.error(`  ${line}`);
    }
    if (result.bogusBaseline.length > 0) {
      console.error("FAIL: baseline entries naming no register entry:");
      for (const line of result.bogusBaseline) console.error(`  ${line}`);
    }
    if (result.newDrift.length > 0) {
      console.error(`FAIL: ${result.newDrift.length} finding(s) recorded fixed whose fix is not reachable from ${checkRef} and not baselined:`);
      for (const entry of result.newDrift) console.error(`  ${entry.id} [${entry.entryClass}] ${entry.detail}`);
    }
    if (result.knownGaps.length > 0) {
      console.error(
        `FAIL: ${result.knownGaps.length} baselined register gap(s) remain; ` +
          "the baseline records history, it does not waive reachability:",
      );
      for (const entryClass of ["unreachable", "unresolvable", "unattributed"]) {
        const group = result.knownGaps.filter((gap) => gap.entryClass === entryClass);
        if (group.length === 0) continue;
        console.error(`  ${entryClass} (${group.length}):`);
        for (const gap of group.slice(0, 5)) console.error(`    ${gap.id} — ${gap.detail}`);
        if (group.length > 5) console.error(`    … ${group.length - 5} more`);
      }
    }
    if (result.staleBaseline.length > 0) {
      console.error("FAIL: baseline entries now reachable:");
      for (const entry of result.staleBaseline) console.error(`  ${entry.id} [${entry.was}] ${entry.detail}`);
    }
    if (result.classDrift.length > 0) {
      console.error("FAIL: baseline entries whose class changed:");
      for (const entry of result.classDrift) console.error(`  ${entry.id} was ${entry.was}, now ${entry.now} — ${entry.detail}`);
    }
    const irreducible = irreducibleRows(result, evidenceById, checkRef);
    if (irreducible.length > 0) {
      const categoryCounts = irreducible.reduce((groups, row) => {
        groups[row.category] = (groups[row.category] || 0) + 1;
        return groups;
      }, {});
      console.error(
        `IRREDUCIBLE_REGISTER_ROWS_JSON=${JSON.stringify({
          checkRef,
          categoryCounts,
          rows: irreducible,
        })}`,
      );
    }
    process.exitCode = 1;
    return;
  }

  if (counts.unverifiable > 0) {
    console.log(
      `PARTIAL PASS: shallow checkout verified ${counts.reachable}/${register.size} register entries against ` +
        `${checkRef}; ${counts.unverifiable} could not be resolved without full history. ` +
        `Re-run with complete history for the real gate.`,
    );
    return;
  }

  const gaps =
    `${baseline.size} published gaps (baseline ${BASELINE_DATE}: ` +
    `${counts.unreachable} unreachable, ${counts.unresolvable} unresolvable, ${counts.unattributed} unattributed)`;
  console.log(
    `PASS: ${counts.reachable}/${register.size} register entries verified reachable from ${checkRef}; ` +
      `${gaps}; 0 new drift.`,
  );
  console.log(`published gaps — baselined, owned by the register backlog (${baseline.size}):`);
  for (const entryClass of ["unreachable", "unresolvable", "unattributed"]) {
    const group = result.knownGaps.filter((gap) => gap.entryClass === entryClass);
    if (group.length === 0) continue;
    console.log(`  ${entryClass} (${group.length}):`);
    for (const gap of group) console.log(`    ${gap.id} — ${gap.detail}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
