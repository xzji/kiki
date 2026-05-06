"use client";

import { ArrowUp, ChevronDown, Link2, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { ChangeEvent, useEffect, useRef, useState } from "react";

export function BottomComposer() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [selectedModel, setSelectedModel] = useState("GPT 5.4");
  const [showConnectorMenu, setShowConnectorMenu] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [attachments, setAttachments] = useState<string[]>([]);
  const composerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isEmpty = value.trim().length === 0;

  const connectorItems = ["Notion", "Google Drive", "Slack", "Linear"];
  const modelItems = ["GPT 5.4", "Claude 4.1", "Gemini 2.5 Pro"];

  const submit = () => {
    const next = value.trim();
    if (!next) return;
    router.push(`/goals/new?title=${encodeURIComponent(next)}`);
    setValue("");
    setAttachments([]);
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
    <div className="fixed bottom-3 left-[276px] right-8 z-20">
      <div
        ref={composerRef}
        className="mx-auto max-w-5xl rounded-2xl border border-[#222]/30 bg-white px-4 py-4 shadow-sm"
      >
        <div className="flex min-h-[90px] flex-col">
          <textarea
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="输入任何想法，我会帮助你，没有什么大不了的事"
            className="min-h-[56px] w-full resize-none bg-transparent text-sm leading-6 text-[#1F2328] outline-none placeholder:text-[#9197A3]"
          />
          {attachments.length > 0 ? (
            <div className="mb-3 flex flex-wrap gap-2">
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
          <div className="mt-auto flex items-center justify-between gap-3 pt-3 text-xs text-[#6B7280]">
            <div className="flex items-center gap-2">
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
                  <div className="absolute bottom-10 left-0 w-44 rounded-xl border border-[#E5E7EB] bg-white p-1 shadow-lg">
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
                  <div className="absolute bottom-10 right-0 w-40 rounded-xl border border-[#E5E7EB] bg-white p-1 shadow-lg">
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
    </div>
  );
}
