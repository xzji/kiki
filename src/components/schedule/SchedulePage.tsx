"use client";

import { useEffect, useMemo, useState } from "react";

import {
  createScheduleEventCommand,
  deleteScheduleEventCommand,
  updateScheduleEventCommand,
} from "@/lib/api/schedule-commands";
import { useVirtualClock } from "@/hooks/useVirtualClock";
import { useScheduleStore } from "@/stores/scheduleStore";
import type { AgentEvent } from "@/types/schedule";

import { DayView } from "./DayView";
import { EventFormDialog } from "./EventFormDialog";
import { EventPopover } from "./EventPopover";
import { MonthView } from "./MonthView";
import { ScheduleHeader } from "./ScheduleHeader";
import { WeekView } from "./WeekView";

export function SchedulePage() {
  const {
    hydrated,
    hydrate,
    events,
    viewMode,
    focusDate,
    setViewMode,
    setFocusDate,
    goToToday,
    prev,
    next,
    replaceEvents,
  } = useScheduleStore();

  const { currentTime } = useVirtualClock();

  useEffect(() => {
    if (!hydrated) hydrate();
  }, [hydrated, hydrate]);

  const [popoverEvent, setPopoverEvent] = useState<{ event: AgentEvent; anchor: DOMRect } | null>(null);
  const [formState, setFormState] = useState<{
    open: boolean;
    initial: AgentEvent | null;
    start?: Date;
    end?: Date;
  }>({ open: false, initial: null });

  const focusDateObj = useMemo(() => new Date(focusDate), [focusDate]);
  const todayObj = useMemo(() => new Date(currentTime), [currentTime]);

  const handleCreate = (start?: Date, end?: Date) => {
    setPopoverEvent(null);
    setFormState({ open: true, initial: null, start, end });
  };

  const handleEdit = (event: AgentEvent) => {
    setPopoverEvent(null);
    setFormState({ open: true, initial: event });
  };

  const handleSubmit = (event: AgentEvent) => {
    const submit = async () => {
      const result = formState.initial
        ? await updateScheduleEventCommand({ event })
        : await createScheduleEventCommand({ event });
      replaceEvents(result.events, result.revision);
      setFormState({ open: false, initial: null });
    };
    void submit().catch((error) => {
      console.error("日程事件保存失败", error);
      window.alert(error instanceof Error ? error.message : "日程事件保存失败");
    });
  };

  const handleDelete = (event: AgentEvent) => {
    const remove = async () => {
      const result = await deleteScheduleEventCommand({ id: event.id });
      replaceEvents(result.events, result.revision);
      setPopoverEvent(null);
    };
    void remove().catch((error) => {
      console.error("日程事件删除失败", error);
      window.alert(error instanceof Error ? error.message : "日程事件删除失败");
    });
  };

  const handleSelectDay = (day: Date) => {
    setFocusDate(day.toISOString());
    setViewMode("day");
  };

  return (
    <div className="w-full pb-24">
      <div>
        <ScheduleHeader
          viewMode={viewMode}
          focusDate={focusDate}
          onToday={() => goToToday(new Date(currentTime).toISOString())}
          onPrev={prev}
          onNext={next}
          onChangeMode={setViewMode}
          onCreate={() => handleCreate()}
        />
        {viewMode === "week" ? (
          <WeekView
            focusDate={focusDateObj}
            today={todayObj}
            events={events}
            onClickEvent={(event, anchor) => setPopoverEvent({ event, anchor })}
            onCreateAt={(start, end) => handleCreate(start, end)}
          />
        ) : null}
        {viewMode === "day" ? (
          <DayView
            focusDate={focusDateObj}
            today={todayObj}
            events={events}
            onClickEvent={(event, anchor) => setPopoverEvent({ event, anchor })}
            onCreateAt={(start, end) => handleCreate(start, end)}
          />
        ) : null}
        {viewMode === "month" ? (
          <MonthView
            focusDate={focusDateObj}
            today={todayObj}
            events={events}
            onClickEvent={(event, anchor) => setPopoverEvent({ event, anchor })}
            onSelectDay={handleSelectDay}
          />
        ) : null}
      </div>
      {popoverEvent ? (
        <EventPopover
          event={popoverEvent.event}
          anchor={popoverEvent.anchor}
          onClose={() => setPopoverEvent(null)}
          onEdit={handleEdit}
          onDelete={handleDelete}
        />
      ) : null}
      <EventFormDialog
        open={formState.open}
        initial={formState.initial}
        defaultStart={formState.start}
        defaultEnd={formState.end}
        onClose={() => setFormState({ open: false, initial: null })}
        onSubmit={handleSubmit}
      />
    </div>
  );
}
