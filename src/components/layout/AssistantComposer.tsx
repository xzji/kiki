"use client";

import { ArrowUp, ChevronDown, Link2, Plus, X } from "lucide-react";
import { ChangeEvent, useEffect, useRef, useState } from "react";

type Props = {
  onSubmit: (value: string) => void;
  placeholder?: string;
  quotedMessage?: {
    roleLabel: string;
    content: string;
  } | null;
  onClearQuote?: () => void;
};

export function AssistantComposer({
  onSubmit,
  placeholder = "输入任何想法，我会帮助你，没有什么大不了的事",
  quotedMessage,
  onClearQuote,
}: Props) {
  const [value, setValue] = useState("");
  const [selectedModel, setSelectedModel] = useState("GPT 5.4");
  const [showConnectorMenu, setShowConnectorMenu] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [attachments, setAttachments] = useState<string[]>([]);
  const composerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isEmpty = value.trim().length === 0;

  const connectorItems = ["Notion", "Google Drive", "Slack", "Linear"];
  const modelItems = ["GPT 5.4", "Claude 4.1", "Gemini 2.5 Pro"];

  const submit = () => {
    const next = value.trim();
    if (!next) return;
    setValue("");
    if (textareaRef.current) textareaRef.current.value = "";
    setAttachments([]);
    onSubmit(next);
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

  return (
    <div
      ref={composerRef}
      className="rounded-2xl border border-[#E5E7EB] bg-white px-3 py-3"
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
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          className="min-h-[48px] w-full resize-none bg-transparent text-sm leading-6 text-[#1F2328] outline-none placeholder:text-[#9197A3]"
        />
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
              className="rounded-md p-1.5 hover:bg-[#F5F6F8]"
              aria-label="上传附件"
              onClick={() => fileInputRef.current?.click()}
            >
              <Plus className="h-4 w-4" />
            </button>
            <div className="relative">
              <button
                type="button"
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
            <button
              type="button"
              onClick={submit}
              disabled={isEmpty}
              className={`rounded-full border p-1.5 transition ${
                isEmpty
                  ? "cursor-not-allowed border-[#E5E7EB] text-[#C1C7D0]"
                  : "border-[#D0D7DE] text-[#111] hover:border-[#111]"
              }`}
              aria-label="发送"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
