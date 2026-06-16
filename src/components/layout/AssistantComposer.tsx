"use client";

import { ArrowUp, ChevronDown, Link2, Plus, Square, X } from "lucide-react";
import { ChangeEvent, useEffect, useRef, useState } from "react";

import { isImeCompositionKeyEvent } from "@/lib/browser/ime";
import { getSlashCommandSuggestions } from "@/lib/slashCommands";
import type { SlashCommand } from "@/lib/slashCommands";
import type { QuotedConversationMessageContext, RuntimeEnvironment, RuntimeInputAttachment } from "@/types/runtime";

type Props = {
  onSubmit: (
    value: string,
    quotedMessage?: QuotedConversationMessageContext | null,
    attachments?: RuntimeInputAttachment[],
  ) => void | Promise<void>;
  placeholder?: string;
  quotedMessage?: QuotedConversationMessageContext | null;
  onClearQuote?: () => void;
  disabled?: boolean;
  localMode?: boolean;
  onStop?: () => void;
  autoFocus?: boolean;
  runtimeEnvironments?: RuntimeEnvironment[];
  activeRuntimeEnvironmentId?: string | null;
  onRuntimeChange?: (runtimeEnvId: string) => void | Promise<void>;
};

function getCommandPayloadPlaceholder(command: SlashCommand) {
  return command.placeholder.replace(new RegExp(`/${command.name}\\s*`), "");
}

function getSlashCommandTrigger(input: string, cursorIndex: number) {
  const safeCursor = Math.max(0, Math.min(cursorIndex, input.length));
  const beforeCursor = input.slice(0, safeCursor);
  const start = beforeCursor.lastIndexOf("/");
  if (start < 0) return null;
  const query = beforeCursor.slice(start + 1);
  if (/\s/.test(query)) return null;
  return { start, end: safeCursor, query };
}

function removeSlashFragment(input: string, start: number, end: number) {
  const next = `${input.slice(0, start)}${input.slice(end)}`;
  return next.replace(/[ \t]{2,}/g, " ");
}

function runtimeKindLabel(runtime: RuntimeEnvironment) {
  if ((runtime.runtimeKind || "claude") === "pi") return "Pi CLI";
  if ((runtime.runtimeKind || "claude") === "claude") return "Claude CLI";
  return runtime.runtimeKind || "Runtime";
}

function readFileAsAttachment(file: File): Promise<RuntimeInputAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      const contentBase64 = value.includes(",") ? value.split(",").pop() || "" : value;
      resolve({
        id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
        filename: file.name,
        mime: file.type || "application/octet-stream",
        size: file.size,
        contentBase64,
      });
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取附件失败"));
    reader.readAsDataURL(file);
  });
}

export function AssistantComposer({
  onSubmit,
  placeholder = "输入任何想法，我会帮助你，没有什么大不了的事",
  quotedMessage,
  onClearQuote,
  disabled = false,
  localMode = false,
  onStop,
  autoFocus = false,
  runtimeEnvironments = [],
  activeRuntimeEnvironmentId,
  onRuntimeChange,
}: Props) {
  const [value, setValue] = useState("");
  const [selectedModel, setSelectedModel] = useState(localMode ? "Claude Code Local" : "GPT 5.4");
  const [showConnectorMenu, setShowConnectorMenu] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const [commandMenuDismissed, setCommandMenuDismissed] = useState(false);
  const [selectedCommand, setSelectedCommand] = useState<SlashCommand | null>(null);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [attachments, setAttachments] = useState<RuntimeInputAttachment[]>([]);
  const composerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const isEmpty = value.trim().length === 0 && attachments.length === 0;
  const slashTrigger = disabled || selectedCommand ? null : getSlashCommandTrigger(value, cursorIndex);
  const commandSuggestions = slashTrigger ? getSlashCommandSuggestions(`/${slashTrigger.query}`) : [];
  const showCommandMenu = commandSuggestions.length > 0 && !commandMenuDismissed;
  const inputPlaceholder = selectedCommand
    ? getCommandPayloadPlaceholder(selectedCommand)
    : placeholder;

  const connectorItems = ["Notion", "Google Drive", "Slack", "Linear"];
  const modelItems = localMode ? ["Claude Code Local"] : ["GPT 5.4", "Claude 4.1", "Gemini 2.5 Pro"];
  const connectedRuntimeEnvironments = runtimeEnvironments.filter(
    (runtime) => runtime.type === "local" && runtime.health?.status === "online",
  );
  const activeRuntimeEnvironment =
    runtimeEnvironments.find((runtime) => runtime.id === activeRuntimeEnvironmentId) ??
    null;
  const activeRuntimeLabel = activeRuntimeEnvironment
    ? activeRuntimeEnvironment.name || runtimeKindLabel(activeRuntimeEnvironment)
    : localMode
      ? "未连接 Runtime"
      : selectedModel;

  const selectCommand = (index: number) => {
    const command = commandSuggestions[index];
    if (!command || !slashTrigger) return;
    const nextValue = removeSlashFragment(value, slashTrigger.start, slashTrigger.end);
    const nextCursor = Math.min(slashTrigger.start, nextValue.length);
    setSelectedCommand(command);
    setValue(nextValue);
    setActiveCommandIndex(0);
    setCommandMenuDismissed(true);
    setCursorIndex(nextCursor);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const submit = () => {
    const payload = value.trim();
    if (isEmpty || disabled) return;
    const next = selectedCommand
      ? `/${selectedCommand.name} ${payload}`.trim()
      : payload || "请查看附件。";
    const submittedAttachments = attachments;
    setValue("");
    setSelectedCommand(null);
    if (textareaRef.current) textareaRef.current.value = "";
    setAttachments([]);
    void onSubmit(next, quotedMessage, submittedAttachments);
  };

  const onFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;
    const nextAttachments = await Promise.all(files.map(readFileAsAttachment));
    setAttachments((current) => [...current, ...nextAttachments]);
  };

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!composerRef.current?.contains(event.target as Node)) {
        setShowConnectorMenu(false);
        setShowModelMenu(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  useEffect(() => {
    if (!autoFocus || disabled) return;
    const frame = window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocus, disabled]);

  return (
    <div
      ref={composerRef}
      className="relative rounded-2xl border border-[#E5E7EB] bg-white px-3 py-3"
    >
      <div className="flex min-h-[84px] flex-col">
        {quotedMessage ? (
          <div className="mb-3 flex items-start justify-between gap-3 rounded-xl border border-[#E5E7EB] bg-[#F8F9FB] px-3 py-2">
            <div className="min-w-0">
              <div className="text-[12px] font-medium text-[#1F2328]">
                引用 {quotedMessage.roleLabel}
              </div>
              <div className="mt-0.5 line-clamp-2 text-[12px] leading-5 text-[#6B7280]">
                {quotedMessage.content}
              </div>
            </div>
            <button
              type="button"
              aria-label="取消引用"
              onClick={onClearQuote}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[#8C9198] hover:bg-white hover:text-[#1F2328]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
        <div className="flex min-h-[48px] items-start gap-2">
          {selectedCommand ? (
            <span className="mt-0.5 shrink-0 rounded-md bg-[#111] px-2 py-1 font-mono text-[12px] leading-4 text-white">
              /{selectedCommand.name}
            </span>
          ) : null}
          <textarea
            ref={textareaRef}
            autoFocus={autoFocus}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setCursorIndex(event.currentTarget.selectionStart);
              setActiveCommandIndex(0);
              setCommandMenuDismissed(Boolean(selectedCommand));
            }}
            onClick={(event) => {
              setCursorIndex(event.currentTarget.selectionStart);
              setCommandMenuDismissed(Boolean(selectedCommand));
            }}
            onSelect={(event) => {
              setCursorIndex(event.currentTarget.selectionStart);
            }}
            onKeyUp={(event) => {
              setCursorIndex(event.currentTarget.selectionStart);
            }}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
            }}
            disabled={disabled}
            onKeyDown={(event) => {
              if (isImeCompositionKeyEvent(event, isComposingRef.current)) return;
              if (
                selectedCommand &&
                event.key === "Backspace" &&
                event.currentTarget.selectionStart === 0 &&
                event.currentTarget.selectionEnd === 0
              ) {
                event.preventDefault();
                setSelectedCommand(null);
                setCommandMenuDismissed(false);
                return;
              }
              if (showCommandMenu) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActiveCommandIndex((prev) => (prev + 1) % commandSuggestions.length);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveCommandIndex((prev) => (prev - 1 + commandSuggestions.length) % commandSuggestions.length);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setCommandMenuDismissed(true);
                  setActiveCommandIndex(0);
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  selectCommand(activeCommandIndex);
                  return;
                }
              }
              if (event.key === "Enter" && !event.shiftKey && !disabled) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder={inputPlaceholder}
            className="min-h-[48px] min-w-0 flex-1 resize-none bg-transparent text-sm leading-6 text-[#1F2328] outline-none placeholder:text-[#9197A3]"
          />
        </div>
        {showCommandMenu ? (
          <div className="absolute bottom-[96px] left-3 z-20 w-[300px] rounded-xl border border-[#E5E7EB] bg-white p-1 shadow-sm">
            {commandSuggestions.map((command, index) => (
              <button
                key={command.name}
                type="button"
                className={`flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left ${
                  index === activeCommandIndex ? "bg-[#F5F6F8]" : "hover:bg-[#F5F6F8]"
                }`}
                onMouseEnter={() => setActiveCommandIndex(index)}
                onClick={() => selectCommand(index)}
              >
                <span className="mt-0.5 rounded-md bg-[#111] px-1.5 py-0.5 font-mono text-[11px] text-white">
                  /{command.name}
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-[#1F2328]">{command.label}</span>
                  <span className="mt-0.5 block text-[12px] leading-4 text-[#6B7280]">
                    {command.description}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : null}
        {attachments.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((attachment) => (
              <span
                key={attachment.id}
                className="inline-flex items-center gap-1.5 rounded-full border border-[#E5E7EB] bg-[#F8FAFC] py-1 pl-3 pr-1.5 text-xs text-[#6B7280]"
              >
                <span className="max-w-[180px] truncate">{attachment.filename}</span>
                <button
                  type="button"
                  aria-label={`删除附件 ${attachment.filename}`}
                  disabled={disabled}
                  onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
                  className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[#8C9198] hover:bg-[#E5E7EB] hover:text-[#1F2328] disabled:cursor-not-allowed"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div className="mt-auto flex items-center justify-between gap-2 pt-2 text-xs text-[#6B7280]">
          <div className="flex items-center gap-1">
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              multiple
              accept="image/*"
              onChange={onFileChange}
            />
            <button
              type="button"
              disabled={disabled}
              className="rounded-md p-1.5 hover:bg-[#F5F6F8] disabled:cursor-not-allowed disabled:text-[#C1C7D0]"
              aria-label="上传附件"
              onClick={() => fileInputRef.current?.click()}
            >
              <Plus className="h-4 w-4" />
            </button>
            <div className="relative">
              <button
                type="button"
                disabled={disabled}
                className="rounded-md p-1.5 hover:bg-[#F5F6F8]"
                aria-label="连接器"
                onClick={() => {
                  setShowConnectorMenu((prev) => !prev);
                  setShowModelMenu(false);
                }}
              >
                <Link2 className="h-4 w-4" />
              </button>
              {showConnectorMenu ? (
                <div className="absolute bottom-10 left-0 z-10 w-44 rounded-xl border border-[#E5E7EB] bg-white p-1">
                  {connectorItems.map((item) => (
                    <button
                      key={item}
                      type="button"
                      className="flex w-full items-center rounded-lg px-3 py-2 text-left text-sm text-[#374151] hover:bg-[#F5F6F8]"
                      onClick={() => setShowConnectorMenu(false)}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <button
                type="button"
                disabled={disabled}
                className="flex max-w-[220px] items-center gap-1 rounded-md px-2 py-1.5 hover:bg-[#F5F6F8] disabled:cursor-not-allowed disabled:text-[#C1C7D0]"
                onClick={() => {
                  setShowModelMenu((prev) => !prev);
                  setShowConnectorMenu(false);
                }}
                title={activeRuntimeEnvironment ? `当前使用：${activeRuntimeLabel}` : undefined}
              >
                <span className="truncate">{activeRuntimeLabel}</span>
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
              {showModelMenu ? (
                <div className="absolute bottom-10 right-0 z-10 w-64 rounded-xl border border-[#E5E7EB] bg-white p-1 shadow-sm">
                  {localMode ? (
                    connectedRuntimeEnvironments.length > 0 ? (
                      connectedRuntimeEnvironments.map((runtime) => {
                        const selected = runtime.id === activeRuntimeEnvironment?.id;
                        return (
                          <button
                            key={runtime.id}
                            type="button"
                            className={`flex w-full items-start justify-between gap-3 rounded-lg px-3 py-2 text-left hover:bg-[#F5F6F8] ${
                              selected ? "text-[#111]" : "text-[#374151]"
                            }`}
                            onClick={() => {
                              setShowModelMenu(false);
                              if (!selected) void onRuntimeChange?.(runtime.id);
                            }}
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-[13px] font-medium">
                                {runtime.name || runtimeKindLabel(runtime)}
                              </span>
                              <span className="mt-0.5 block truncate text-[11px] text-[#6B7280]">
                                {runtimeKindLabel(runtime)} · {runtime.permissionMode}
                              </span>
                            </span>
                            {selected ? (
                              <span className="mt-0.5 shrink-0 rounded-full bg-[#ECFDF3] px-2 py-0.5 text-[11px] text-[#067647]">
                                当前
                              </span>
                            ) : null}
                          </button>
                        );
                      })
                    ) : (
                      <div className="px-3 py-2 text-[12px] leading-5 text-[#6B7280]">
                        暂无已连接 Runtime，请到设置中连接。
                      </div>
                    )
                  ) : (
                    modelItems.map((item) => (
                      <button
                        key={item}
                        type="button"
                        className={`flex w-full items-center rounded-lg px-3 py-2 text-left text-sm hover:bg-[#F5F6F8] ${
                          item === selectedModel ? "text-[#111]" : "text-[#374151]"
                        }`}
                        onClick={() => {
                          setSelectedModel(item);
                          setShowModelMenu(false);
                        }}
                      >
                        {item}
                      </button>
                    ))
                  )}
                </div>
              ) : null}
            </div>
            {disabled && onStop ? (
              <button
                type="button"
                onClick={onStop}
                className="rounded-full border border-[#D0D7DE] p-1.5 text-[#B42318] transition hover:border-[#B42318] hover:bg-[#FEF2F2]"
                aria-label="停止生成"
              >
                <Square className="h-4 w-4 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={isEmpty || disabled}
                className={`rounded-full border p-1.5 transition ${
                  isEmpty || disabled
                    ? "cursor-not-allowed border-[#E5E7EB] text-[#C1C7D0]"
                    : "border-[#D0D7DE] text-[#111] hover:border-[#111]"
                }`}
                aria-label="发送"
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
