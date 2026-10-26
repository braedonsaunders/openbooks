import { UrlDrawer } from "@openbooks/ui";
import { EntityListView } from "../../../../components/entity-list-view";
import { ChangeEvidence } from "../changes/ChangeEvidence";
import { ProvisionAssessmentButton, ProvisionAssessmentHistory } from "./ProvisionAssessmentButton";
import type { provisionEditorOptions, readProvisionObligation } from "@openbooks/engine/provisions";

export interface ProvisionAssessmentWorkspaceData {
  orgId: string;
  userId: string;
  sp: Record<string, string | string[] | undefined>;
  editorError: string | null;
  emptyTitle: string;
  reviewHint: string;
  options: Awaited<ReturnType<typeof provisionEditorOptions>> | null;
  detail: Awaited<ReturnType<typeof readProvisionObligation>> | null;
  isNew: boolean;
  assessmentOpen: boolean;
  newHref: string;
  newCloseHref: string;
  assessmentOpenHref: string;
  assessmentCloseHref: string;
  detailCloseHref: string;
}

export async function ProvisionsWorkspace({ data }: { data: ProvisionAssessmentWorkspaceData }) {
  const { options, detail, isNew } = data;
  return (
    <>
      {data.editorError ? (
        <p role="alert" className="text-sm text-red-600">
          {data.editorError}
        </p>
      ) : null}
      {isNew && options ? (
        <ProvisionAssessmentButton
          options={options}
          assessmentOpen
          openHref={data.newHref}
          closeHref={data.newCloseHref}
          showTrigger={false}
        />
      ) : null}
      <EntityListView
        recordType="provision_obligation"
        orgId={data.orgId}
        userId={data.userId}
        canManage={false}
        sp={data.sp}
        emptyTitle={data.emptyTitle}
        drawer={
          detail ? (
            <UrlDrawer
              open
              title={detail.identity.name}
              closeHref={data.detailCloseHref}
              size="2xl"
            >
              <div className="space-y-5">
                <p className="text-sm text-muted-foreground">{data.reviewHint}</p>
                {options ? (
                  <ProvisionAssessmentButton
                    options={options}
                    identity={detail.identity}
                    assessmentOpen={data.assessmentOpen}
                    openHref={data.assessmentOpenHref}
                    closeHref={data.assessmentCloseHref}
                    stacked
                  />
                ) : null}
                <ChangeEvidence value={detail.identity} />
                <ProvisionAssessmentHistory assessments={detail.assessments} />
              </div>
            </UrlDrawer>
          ) : undefined
        }
      />
    </>
  );
}
