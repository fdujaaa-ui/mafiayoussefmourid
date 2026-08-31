export type RoleId = "mafia" | "doctor" | "detective" | "citizen";

export type Role = {
  id: RoleId;
  name: string;
  team: "mafia" | "town";
  emoji: string;
  desc: string;
};

export const ROLES: Record<RoleId, Role> = {
  mafia: {
    id: "mafia",
    name: "مافيا",
    team: "mafia",
    emoji: "🔪",
    desc: "تستيقظ ليلاً مع رفاقك وتختارون ضحية. اخدع الجميع نهاراً.",
  },
  doctor: {
    id: "doctor",
    name: "الطبيب",
    team: "town",
    emoji: "🩺",
    desc: "كل ليلة تنقذ لاعباً واحداً من هجوم المافيا.",
  },
  detective: {
    id: "detective",
    name: "المحقق",
    team: "town",
    emoji: "🔍",
    desc: "كل ليلة تتحقق من لاعب لتعرف إن كان من المافيا.",
  },
  citizen: {
    id: "citizen",
    name: "مواطن",
    team: "town",
    emoji: "👤",
    desc: "لا تملك قدرة خاصة، سلاحك الحوار والتصويت الذكي.",
  },
};

export type Player = {
  id: number;
  name: string;
  role: RoleId;
  alive: boolean;
};

export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function suggestedMafia(count: number) {
  return Math.max(1, Math.floor(count / 4));
}

export function buildRoles(
  count: number,
  mafiaCount: number,
  doctor: boolean,
  detective: boolean,
): RoleId[] {
  const roles: RoleId[] = [];
  for (let i = 0; i < mafiaCount; i++) roles.push("mafia");
  if (doctor) roles.push("doctor");
  if (detective) roles.push("detective");
  while (roles.length < count) roles.push("citizen");
  return shuffle(roles.slice(0, count));
}

export function checkWinner(players: Player[]): "mafia" | "town" | null {
  const alive = players.filter((p) => p.alive);
  const mafia = alive.filter((p) => ROLES[p.role].team === "mafia").length;
  const town = alive.length - mafia;
  if (mafia === 0) return "town";
  if (mafia >= town) return "mafia";
  return null;
}
