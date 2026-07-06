"use client";

import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

type ConfirmVariant = "default" | "danger";

export type ConfirmOptions = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ConfirmVariant;
};

type ConfirmContextValue = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

type DialogState = ConfirmOptions & { open: boolean };

export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DialogState>({ open: false, title: "" });
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmContextValue>((options) => {
    // Resolve any in-flight confirm as cancelled before opening a new one,
    // so the previous awaiter never dangles.
    resolverRef.current?.(false);
    setState({ ...options, open: true });
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const settle = useCallback((result: boolean) => {
    resolverRef.current?.(result);
    resolverRef.current = null;
    setState((prev) => ({ ...prev, open: false }));
  }, []);

  const isDanger = state.variant === "danger";

  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <AlertDialog.Root
        open={state.open}
        onOpenChange={(open) => {
          if (!open) settle(false);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-[100] bg-black/30" />
          <AlertDialog.Content
            {...(state.description ? {} : { "aria-describedby": undefined })}
            className="fixed left-1/2 top-1/2 z-[101] w-[420px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-white p-5 shadow-2xl focus:outline-none"
          >
            <AlertDialog.Title className="text-[16px] font-semibold text-ink">
              {state.title}
            </AlertDialog.Title>
            {state.description ? (
              <AlertDialog.Description className="mt-3 whitespace-pre-line text-[13px] leading-6 text-ink-strong">
                {state.description}
              </AlertDialog.Description>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <button
                  type="button"
                  className="inline-flex h-9 items-center rounded-lg border border-line bg-white px-3 text-[13px] text-[#111] hover:bg-surface-hover"
                >
                  {state.cancelLabel ?? "取消"}
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  onClick={() => settle(true)}
                  className={cn(
                    "inline-flex h-9 items-center rounded-lg px-3 text-[13px] text-white",
                    isDanger ? "bg-danger hover:bg-danger-hover" : "bg-[#111] hover:bg-[#333]",
                  )}
                >
                  {state.confirmLabel ?? "确认"}
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmContextValue {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error("useConfirm must be used within ConfirmDialogProvider");
  }
  return ctx;
}
