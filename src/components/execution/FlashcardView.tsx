"use client";

import { useState } from "react";

import type { FlashCard } from "@/types/dora";

export function FlashcardView({ cards, onComplete }: { cards: FlashCard[]; onComplete: () => void }) {
  const [index, setIndex] = useState(0);
  const card = cards[index];
  const progress = Math.min(cards.length, index + 5);

  return (
    <div className="space-y-6">
      <div className="text-sm font-medium text-[#111]">{progress}/{cards.length}</div>
      <div className="mx-auto max-w-md rounded-xl border border-[#111] bg-white p-5">
        <div className="text-xl font-semibold text-[#111]">{card.word} <span className="text-sm font-normal text-[#6B7280]">{card.phonetic}</span></div>
        <div className="mt-1 text-sm text-[#6B7280]">{card.partOfSpeech} {card.meaning}</div>
        <div className="mt-4 space-y-3 text-sm leading-6 text-[#374151]">
          {card.examples.map((example, exampleIndex) => (
            <div key={`${card.id}-${exampleIndex}`}>
              <div>{example.en}</div>
              <div className="text-[#6B7280]">{example.zh}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="flex justify-center">
        <button className="rounded-md border border-[#7D8590] px-6 py-1.5 text-xs text-[#111] hover:bg-[#F5F6F8]" onClick={() => (index === cards.length - 1 ? onComplete() : setIndex((prev) => prev + 1))}>{index === cards.length - 1 ? "完成" : "下一个"}</button>
      </div>
    </div>
  );
}
