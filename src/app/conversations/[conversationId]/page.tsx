import { Suspense } from "react";

import { ConversationView } from "@/components/conversation/ConversationView";

export default function ConversationPage({ params }: { params: { conversationId: string } }) {
  return (
    <Suspense fallback={<ConversationPageLoading />}>
      <ConversationView key={params.conversationId} conversationId={params.conversationId} />
    </Suspense>
  );
}

function ConversationPageLoading() {
  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <header className="flex h-12 flex-none items-center border-b border-[#E5E7EB] px-4 sm:px-6 lg:px-8">
        <div className="h-4 w-32 animate-pulse rounded-full bg-[#E5E7EB]" />
      </header>
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="rounded-2xl border border-[#E5E7EB] bg-[#F8F9FB] px-4 py-3 text-[13px] text-[#6B7280]">
          正在进入会话...
        </div>
      </div>
    </div>
  );
}
