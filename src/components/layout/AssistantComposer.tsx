"use client";

import { ArrowUp, ChevronDown, Link2, Plus, Square, X } from "lucide-react";
import { ChangeEvent, useEffect, useRef, useState } from "react";

import { getSlashCommandSuggestions } from "@/lib/slashCommands";
import type { SlashCommand } from "@/lib/slashCommands";

type Props = {
  onSubmit: (
    value: string,
    quotedMessage?: {
      roleLabel: string;
      content: string;
    } | null,
  ) => void | Promise<void>;
  placeholder?: string;
  quotedMessage?: {
    roleLabel: string;
    content: string;
  } | null;
  onClearQuote?: () => void;
  disabled?: boolean;
  localMode?: boolean;
  onStop?: () => void;
  autoFocus?: boolean;
};

function getCommandPayloadPlaceholder(command: SlashCommand) {
  return command.placeholder.replace(new RegExp(`/${command.name}\\s*`), "");
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
}: Props) {
  const [value, setValue] = useState("");
  const [selectedModel, setSelectedModel] = useState(localMode ? "Claude Code Local" : "GPT 5.4");
  const [showConnectorMenu, setShowConnectorMenu] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const [commandMenuDismissed, setCommandMenuDismissed] = useState(false);
  const [selectedCommand, setSelectedCommand] = useState<SlashCommand | null>(null);
  const [attachments, setAttachments] = useState<string[]>([]);
  const composerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isEmpty = value.trim().length === 0;
  const commandSuggestions = disabled || selectedCommand ? [] : getSlashCommandSuggestions(value);
  const showCommandMenu = commandSuggestions.length > 0 && !commandMenuDismissed;
  const inputPlaceholder = selectedCommand
    ? getCommandPayloadPlaceholder(selectedCommand)
    : placeholder;

  const connectorItems = ["Notion", "Google Drive", "Slack", "Linear"];
  const modelItems = localMode ? ["Claude Code Local"] : ["GPT 5.4", "Claude 4.1", "Gemini 2.5 Pro"];

  const selectCommand = (index: number) => {
    const command = commandSuggestions[index];
    if (!command) return;
    setSelectedCommand(command);
    setValue("");
    setActiveCommandIndex(0);
    setCommandMenuDismissed(true);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(0, 0);
    });
  };

  const submit = () => {
    const payload = value.trim();
    if (!payload || disabled) return;
    const next = selectedCommand ? `/${selectedCommand.name} ${payload}` : payload;
    setValue("");
    setSelectedCommand(null);
    if (textareaRef.current) textareaRef.current.value = "";
    setAttachments([]);
    void onSubmit(next, quotedMessage);
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    setAttachments(files.map((file) => file.name));
    event.target.value = "";
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
              setActiveCommandIndex(0);
              setCommandMenuDismissed(Boolean(selectedCommand));
            }}
            disabled={disabled}
            onKeyDown={(event) => {
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
          <div className="absolute bottom-[74px] left-3 z-20 w-[300px] rounded-xl border border-[#E5E7EB] bg-white p-1 shadow-sm">
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
            {attachments.map((fileName) => (
              <span
                key={fileName}
                className="inline-flex items-center rounded-full border border-[#E5E7EB] bg-[#F8FAFC] px-3 py-1 text-xs text-[#6B7280]"
              >
                {fileName}
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
                className="flex items-center gap-1 rounded-md px-2 py-1.5 hover:bg-[#F5F6F8]"
                onClick={() => {
                  setShowModelMenu((prev) => !prev);
                  setShowConnectorMenu(false);
                }}
              >
                <span>{selectedModel}</span>
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
              {showModelMenu ? (
                <div className="absolute bottom-10 right-0 z-10 w-40 rounded-xl border border-[#E5E7EB] bg-white p-1">
                  {modelItems.map((item) => (
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
                  ))}
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
