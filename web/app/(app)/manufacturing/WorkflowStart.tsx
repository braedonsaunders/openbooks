"use client";
import { useRouter } from "next/navigation";
import { OperatingProfilePicker } from "@/components/operating-profile-picker";
import type { OperatingProfileChoice } from "@openbooks/engine/src/organization/operating-profiles.ts";

/** Starting from the cockpit carries the selected composition into the same native create drawer. */
export function WorkflowStart({ choices }: { choices: OperatingProfileChoice[] }) {
  const router=useRouter();
  return <OperatingProfilePicker family="production" initialChoices={choices} value={null} onChoose={(choice,departmentId)=>{
    router.push("/manufacturing/work-orders?"+new URLSearchParams({record:"new",workflow:choice.value,...(departmentId?{departmentId}:{})}).toString());
  }}/>;
}
