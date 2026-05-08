import { ConversationView } from "@/components/conversation/ConversationView";

export default function ConversationPage({ params }: { params: { conversationId: string } }) {
  return <ConversationView conversationId={params.conversationId} />;
}
