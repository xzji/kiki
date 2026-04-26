import { useRouter } from "next/navigation";

import type { Goal, Task } from "@/types/dora";
import { TaskRow } from "@/components/goal/TaskRow";

export function SubGoalBlock({ goal, subGoal, unreadByTask, onEditTask }: { goal: Goal; subGoal: Goal["subGoals"][number]; unreadByTask: Record<string, number>; onEditTask: (task: Task) => void }) {
  const router = useRouter();

  return (
    <section className="border-t border-[#D8DDE4] py-5 first:border-t-0 first:pt-0">
      <h2 className="mb-3 text-sm font-semibold text-[#111]">{subGoal.title}</h2>
      <div className="space-y-1">
        {subGoal.tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            unreadCount={unreadByTask[task.id] ?? 0}
            onOpen={() => router.push(`/goals/${goal.id}/tasks/${task.id}`)}
            onEdit={() => onEditTask(task)}
          />
        ))}
      </div>
    </section>
  );
}
