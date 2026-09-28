/** Bundled characters (characters/<id>.svg). Add one here and drop its SVG into the characters folder. */
export const CHARACTERS = [
  { id: "mochi", name: { ja: "もち", en: "Mochi" } },
  { id: "robo", name: { ja: "ロボ", en: "Robo" } },
  { id: "owl", name: { ja: "フクロウ先生", en: "Professor Owl" } },
  { id: "neko", name: { ja: "ねこ", en: "Cat" } },
  { id: "pengin", name: { ja: "ペンギン", en: "Penguin" } },
  { id: "kitsune", name: { ja: "きつね", en: "Fox" } },
  { id: "obake", name: { ja: "おばけ", en: "Ghost" } },
  { id: "hiyoko", name: { ja: "ひよこ", en: "Chick" } },
];

export function characterName(character, language) {
  return character.name[language] ?? character.name.ja;
}
