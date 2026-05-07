export type AgentEventColor = "blue" | "green" | "purple" | "pink" | "orange" | "cyan";

export interface Attendee {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string;
}

export interface AgentEvent {
  id: string;
  title: string;
  description?: string;
  startTime: string;
  endTime: string;
  isAllDay: boolean;
  attendees: Attendee[];
  color?: AgentEventColor;
  location?: string;
  status?: "normal" | "cancelled";
  createdByAgent: boolean;
  agentActions?: Array<{
    label: string;
    type: "primary" | "secondary";
    payload?: Record<string, unknown>;
  }>;
}

export type ScheduleViewMode = "day" | "week" | "month";
