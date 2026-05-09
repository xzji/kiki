import type { FlashCard } from "@/types/kiki";

const words = [
  ["Celestial", "[səˈlestiəl]", "adj.", "天体的；天空的"],
  ["Astronomical", "[ˌæstrəˈnɒmɪkəl]", "adj.", "天文学的"],
  ["Hypothesis", "[haɪˈpɒθəsɪs]", "n.", "假设"],
  ["Artifact", "[ˈɑːrtɪfækt]", "n.", "人工制品"],
  ["Sediment", "[ˈsedɪmənt]", "n.", "沉积物"],
  ["Ecology", "[iˈkɒlədʒi]", "n.", "生态学"],
  ["Photosynthesis", "[ˌfoʊtoʊˈsɪnθəsɪs]", "n.", "光合作用"],
  ["Bioluminescent", "[ˌbaɪoʊˌluːməˈnesənt]", "adj.", "生物发光的"],
  ["Migrate", "[maɪˈɡreɪt]", "v.", "迁徙"],
  ["Erosion", "[ɪˈroʊʒən]", "n.", "侵蚀"],
  ["Dormant", "[ˈdɔːrmənt]", "adj.", "休眠的"],
  ["Catalyst", "[ˈkætəlɪst]", "n.", "催化剂"],
  ["Geothermal", "[ˌdʒiːoʊˈθɜːrməl]", "adj.", "地热的"],
  ["Momentum", "[moʊˈmentəm]", "n.", "动量"],
  ["Spectrum", "[ˈspektrəm]", "n.", "光谱；范围"],
  ["Tectonic", "[tekˈtɒnɪk]", "adj.", "构造的"],
  ["Microbe", "[ˈmaɪkroʊb]", "n.", "微生物"],
  ["Cognitive", "[ˈkɒɡnətɪv]", "adj.", "认知的"],
  ["Equilibrium", "[ˌiːkwɪˈlɪbriəm]", "n.", "平衡"],
  ["Nocturnal", "[nɒkˈtɜːrnəl]", "adj.", "夜间活动的"],
  ["Glacier", "[ˈɡleɪʃər]", "n.", "冰川"],
  ["Terrain", "[təˈreɪn]", "n.", "地形"],
  ["Fossil", "[ˈfɒsəl]", "n.", "化石"],
  ["Diverse", "[daɪˈvɜːrs]", "adj.", "多样的"],
  ["Orbit", "[ˈɔːrbɪt]", "n./v.", "轨道；绕行"],
  ["Decay", "[dɪˈkeɪ]", "n./v.", "衰变；腐烂"],
  ["Predator", "[ˈpredətər]", "n.", "捕食者"],
  ["Habitat", "[ˈhæbɪtæt]", "n.", "栖息地"],
  ["Correlate", "[ˈkɒrəleɪt]", "v.", "关联"],
  ["Resilient", "[rɪˈzɪliənt]", "adj.", "有韧性的"],
] as const;

export const flashcards: FlashCard[] = words.map((item, index) => ({
  id: `flashcard-${index + 1}`,
  word: item[0],
  phonetic: item[1],
  partOfSpeech: item[2],
  meaning: item[3],
  examples: [
    {
      en: `The ${item[0].toLowerCase()} observation helped the researchers refine the lecture notes.`,
      zh: `对 ${item[0]} 相关现象的观察帮助研究者完善了讲义。`,
    },
    {
      en: `Students should master the word ${item[0].toLowerCase()} before the next TOEFL practice session.`,
      zh: `学生应在下一次托福练习前掌握单词 ${item[0]}。`,
    },
  ],
}));
