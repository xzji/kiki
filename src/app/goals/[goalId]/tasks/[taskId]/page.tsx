import { permanentRedirect } from "next/navigation";

import { legacyGoalTaskRedirectPath, type RouteSearchParams } from "@/lib/routes";

export default function LegacyGoalTaskPage({
  params,
  searchParams,
}: {
  params: { goalId: string; taskId: string };
  searchParams?: RouteSearchParams;
}) {
  permanentRedirect(legacyGoalTaskRedirectPath(params.goalId, params.taskId, searchParams));
}
