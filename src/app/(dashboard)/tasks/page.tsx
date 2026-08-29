import { TasksClient } from "@/app/(dashboard)/tasks/tasks-client";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";

export default async function TasksPage() {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tasks")
    .select("id, title, status, due_at, related_entity_type, related_entity_id, created_at")
    .eq("organization_id", currentOrg.organizationId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);

  return <TasksClient tasks={data ?? []} />;
}
