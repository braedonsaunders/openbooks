import { mergeHref } from "../../../../lib/list-params";

export function provisionDrawerLinks(sp: Record<string, string | string[] | undefined>) {
  return {
    newHref: mergeHref("/accounting/provisions", sp, { provision: "new", assess: undefined }),
    newCloseHref: mergeHref("/accounting/provisions", sp, {
      provision: undefined,
      assess: undefined,
      drawerReturn: undefined,
    }),
    assessmentOpenHref: mergeHref("/accounting/provisions", sp, { assess: "1" }),
    assessmentCloseHref: mergeHref("/accounting/provisions", sp, { assess: undefined }),
    detailCloseHref: mergeHref("/accounting/provisions", sp, {
      provision: undefined,
      assess: undefined,
      drawerReturn: undefined,
    }),
  };
}
