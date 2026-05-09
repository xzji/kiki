"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactNode, useState } from "react";

import { GoalSchedulerRuntime } from "@/components/providers/GoalSchedulerRuntime";

export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <GoalSchedulerRuntime />
      {children}
    </QueryClientProvider>
  );
}
