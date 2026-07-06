"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactNode, useState } from "react";
import { Toaster } from "sonner";

import { ConfirmDialogProvider } from "@/components/common/ConfirmDialog";
import { GoalSchedulerRuntime } from "@/components/providers/GoalSchedulerRuntime";
import { RuntimeEventBridge } from "@/components/providers/RuntimeEventBridge";

export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <RuntimeEventBridge />
      <GoalSchedulerRuntime />
      <ConfirmDialogProvider>{children}</ConfirmDialogProvider>
      <Toaster position="top-center" richColors closeButton />
    </QueryClientProvider>
  );
}
