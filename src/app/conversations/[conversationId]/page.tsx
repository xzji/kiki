import { Suspense } from "react";

import { ConversationView } from "@/components/conversation/ConversationView";

export default function ConversationPage({ params }: { params: { conversationId: string } }) {
  return (
    <Suspense fallback={null}>
      <ConversationView key={params.conversationId} conversationId={params.conversationId} />
    </Suspense>
  );
}
