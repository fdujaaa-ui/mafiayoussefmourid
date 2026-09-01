import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ROLES,
  buildRoles,
  checkWinner,
  shuffle,
  suggestedMafia,
  type Player,
  type RoleId,
} from "@/lib/mafia";
import { initNarrator, prefetch, speak, stopSpeaking } from "@/lib/narrator";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ليلة المافيا — لعبة المافيا بمرشد صوتي عربي" },
      {
        name: "description",
        content:
          "العب المافيا مع أصدقائك بهاتف واحد: توزيع أدوار تلقائي، مرشد صوتي عربي فوري يدير الليل والنهار، وتصويت وحساب فائز.",
      },
      { property: "og:title", content: "ليلة المافيا — لعبة المافيا بمرشد صوتي" },
      {
        property: "og:description",
        content: "مدير لعبة المافيا الاحترافي بصوت عربي فوري يدير كل الجولات.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: MafiaGame,
});

type Phase = "setup" | "reveal" | "night" | "morning" | "vote" | "end";

type NightStep = {
  text: string;
  pause: number;
  action?: "mafia" | "doctor" | "detective";
};

function MafiaGame() {
  const [phase, setPhase] = useState<Phase>("setup");
  const [muted, setMuted] = useState(false);
  const [playerCount, setPlayerCount] = useState(8);
  const [names, setNames] = useState<string[]>(
    Array.from({ length: 8 }, (_, i) => `اللاعب ${i + 1}`),
  );
  const [mafiaCount, setMafiaCount] = useState(2);
  const [useDoctor, setUseDoctor] = useState(true);
  const [useDetective, setUseDetective] = useState(true);

  const [players, setPlayers] = useState<Player[]>([]);
  const [revealIndex, setRevealIndex] = useState(0);
  const [revealShown, setRevealShown] = useState(false);

  const [night, setNight] = useState(1);
  const [stepIndex, setStepIndex] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  const [awaitingPick, setAwaitingPick] = useState(false);
  const [nightPick, setNightPick] = useState<number | null>(null);
  const [mafiaTarget, setMafiaTarget] = useState<number | null>(null);
  const [doctorTarget, setDoctorTarget] = useState<number | null>(null);
  const [detectiveResult, setDetectiveResult] = useState<string | null>(null);
  const [morningText, setMorningText] = useState("");
  const [voteTarget, setVoteTarget] = useState<number | null>(null);
  const [voteResult, setVoteResult] = useState<string | null>(null);
  const [winner, setWinner] = useState<"mafia" | "town" | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const timerRef = useRef<number | null>(null);
  const retryNarrationRef = useRef<(() => void) | null>(null);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  useEffect(() => {
    initNarrator();
    return () => {
      stopSpeaking();
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    const n = Math.max(4, Math.min(16, playerCount));
    setNames((prev) =>
      Array.from({ length: n }, (_, i) => prev[i] ?? `اللاعب ${i + 1}`),
    );
    setMafiaCount((m) => Math.min(Math.max(1, m), Math.floor(n / 2) - 1 || 1));
  }, [playerCount]);

  const alive = players.filter((p) => p.alive);
  const aliveRoles = new Set(alive.map((p) => p.role));

  const nightSteps = useMemo<NightStep[]>(() => {
    const steps: NightStep[] = [
      {
        text: `الليلة رقم ${night} بدأت. المدينة تنام الآن. الجميع يغمض عينيه.`,
        pause: 4500,
      },
      {
        text: "المافيا، افتحوا أعينكم. تعرّفوا على بعضكم، ثم اختاروا ضحيتكم.",
        pause: 300,
        action: "mafia",
      },
      { text: "المافيا، أغمضوا أعينكم.", pause: 3500 },
    ];
    if (aliveRoles.has("doctor")) {
      steps.push({
        text: "الطبيب، افتح عينيك. من تريد أن تنقذ هذه الليلة؟",
        pause: 300,
        action: "doctor",
      });
      steps.push({ text: "الطبيب، أغمض عينيك.", pause: 3500 });
    }
    if (aliveRoles.has("detective")) {
      steps.push({
        text: "المحقق، افتح عينيك. من تشك فيه هذه الليلة؟",
        pause: 300,
        action: "detective",
      });
      steps.push({ text: "المحقق، أغمض عينيك.", pause: 3500 });
    }
    steps.push({
      text: "انتهى الليل. أشرقت الشمس، افتحوا أعينكم جميعاً.",
      pause: 800,
    });
    return steps;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [night, players]);

  const say = useCallback((text: string, then?: () => void, pause = 0) => {
    setSpeaking(true);
    setVoiceError(null);
    retryNarrationRef.current = () => say(text, then, pause);
    speak(text, {
      muted: mutedRef.current,
      onError: (message) => setVoiceError(message),
      onEnd: () => {
        if (timerRef.current) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => {
          setSpeaking(false);
          then?.();
        }, pause);
      },
    });
  }, []);

  /* ---------------- setup ---------------- */
  function startGame() {
    const roles = buildRoles(playerCount, mafiaCount, useDoctor, useDetective);
    const list: Player[] = names
      .slice(0, playerCount)
      .map((n, i) => ({
        id: i,
        name: n.trim() || `اللاعب ${i + 1}`,
        role: roles[i] as RoleId,
        alive: true,
      }));
    const shuffledPlayers = shuffle(list).map((p, i) => ({ ...p, id: i }));
    setPlayers(shuffledPlayers);
    setRevealIndex(0);
    setRevealShown(false);
    setLog([]);
    setNight(1);
    setWinner(null);
    setPhase("reveal");
    initNarrator();
    say(
      `بدأ توزيع الأدوار. يمسك كل لاعب الهاتف وحده، يكشف دوره ويحفظه، ثم يمرر الهاتف. ${shuffledPlayers[0]?.name ?? "اللاعب الأول"}، أمسك الهاتف الآن وتأكد أن لا أحد يرى الشاشة.`,
    );
  }

  /* ---------------- reveal ---------------- */
  function nextReveal() {
    if (revealIndex + 1 < players.length) {
      const nextIndex = revealIndex + 1;
      setRevealIndex(nextIndex);
      setRevealShown(false);
      say(`${players[nextIndex]?.name ?? "اللاعب التالي"}، أمسك الهاتف الآن وحدك، واستعد لرؤية دورك بسرية.`);
    } else {
      say(
        "اكتمل توزيع الأدوار. ضعوا الهاتف في المنتصف، والجميع يغمض عينيه الآن. تبدأ الليلة الأولى.",
        () => startNight(1),
      );
    }
  }

  /* ---------------- night ---------------- */
  const startNight = useCallback(
    (n: number) => {
      setNight(n);
      setMafiaTarget(null);
      setDoctorTarget(null);
      setDetectiveResult(null);
      setStepIndex(0);
      setAwaitingPick(false);
      setPhase("night");
    },
    [],
  );

  // Warm the next lines so the narrator never lags behind the game.
  useEffect(() => {
    if (muted) return;
    if (phase === "reveal") {
      nightSteps.forEach((s) => prefetch(s.text));
    } else if (phase === "night") {
      nightSteps.slice(stepIndex + 1, stepIndex + 4).forEach((s) => prefetch(s.text));
      prefetch("نعم، هذا الشخص من المافيا.");
      prefetch("لا، هذا الشخص بريء.");
      prefetch("حان وقت التصويت. اختاروا من تشكّون أنه من المافيا.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, stepIndex, muted]);

  useEffect(() => {
    if (phase !== "night") return;
    const step = nightSteps[stepIndex];
    if (!step) return;
    setAwaitingPick(false);
    say(
      step.text,
      () => {
        if (step.action) {
          setAwaitingPick(true);
        } else if (stepIndex + 1 < nightSteps.length) {
          setStepIndex((i) => i + 1);
        } else {
          resolveNight();
        }
      },
      step.pause,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, stepIndex]);

  function pick(step: NightStep, playerId: number) {
    setAwaitingPick(false);
    if (step.action === "mafia") {
      setMafiaTarget(playerId);
      advance();
    } else if (step.action === "doctor") {
      setDoctorTarget(playerId);
      advance();
    } else if (step.action === "detective") {
      const target = players.find((p) => p.id === playerId);
      if (!target) return;
      const isMafia = ROLES[target.role].team === "mafia";
      setDetectiveResult(
        `${target.name}: ${isMafia ? "من المافيا ⚠️" : "بريء ✅"}`,
      );
      say(isMafia ? "نعم، هذا الشخص من المافيا." : "لا، هذا الشخص بريء.", () =>
        advance(),
      );
    }
  }

  function advance() {
    setStepIndex((i) => {
      if (i + 1 < nightSteps.length) return i + 1;
      resolveNight();
      return i;
    });
  }

  function resolveNight() {
    const saved = mafiaTarget !== null && mafiaTarget === doctorTarget;
    let text = "";
    let updated = players;
    if (mafiaTarget === null || saved) {
      const attacked = players.find((p) => p.id === mafiaTarget);
      text = saved
        ? `هاجمت المافيا ${attacked?.name ?? "أحد اللاعبين"}، لكن الطبيب أنقذه في اللحظة الأخيرة. لم يمت أحد هذه الليلة.`
        : "مرّت الليلة بسلام، لم يمت أحد.";
    } else {
      const victim = players.find((p) => p.id === mafiaTarget);
      if (!victim) return;
      updated = players.map((p) =>
        p.id === mafiaTarget ? { ...p, alive: false } : p,
      );
      text = `مع شروق الشمس، وُجد ${victim.name} مقتولاً على يد المافيا. خرج من اللعبة، وكان دوره ${ROLES[victim.role].name}.`;
      setPlayers(updated);
    }
    setLog((l) => [...l, `🌙 الليلة ${night}: ${text}`]);
    setMorningText(text);
    setPhase("morning");
    const w = checkWinner(updated);
    say(text, () => {
      if (w) endGame(w);
    });
  }

  /* ---------------- day / vote ---------------- */
  function startVote() {
    setVoteTarget(null);
    setVoteResult(null);
    setPhase("vote");
    say("حان وقت التصويت. اختاروا من تشكّون أنه من المافيا.");
  }

  function confirmVote() {
    if (voteTarget === null) return;
    const target = players.find((p) => p.id === voteTarget);
    if (!target) return;
    const updated = players.map((p) =>
      p.id === voteTarget ? { ...p, alive: false } : p,
    );
    setPlayers(updated);
    const text = `انتهى تصويت أهل المدينة. تم إخراج ${target.name} من اللعبة، وكان دوره ${ROLES[target.role].name}.`;
    setVoteResult(text);
    setLog((l) => [...l, `☀️ نهار ${night}: ${text}`]);
    const w = checkWinner(updated);
    say(text, () => {
      if (w) endGame(w);
    });
  }

  function endGame(w: "mafia" | "town") {
    setWinner(w);
    setPhase("end");
    say(
      w === "mafia"
        ? "انتهت اللعبة. المافيا سيطرت على المدينة، الفوز للمافيا!"
        : "انتهت اللعبة. تم القضاء على كل أفراد المافيا، الفوز للمدينة!",
    );
  }

  function resetAll() {
    stopSpeaking();
    setPhase("setup");
    setPlayers([]);
    setWinner(null);
    setLog([]);
  }

  const currentStep = nightSteps[stepIndex];

  /* ---------------- UI ---------------- */
  return (
    <div dir="rtl" className="min-h-screen px-4 py-6 sm:px-6">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 pb-6">
        <div>
          <h1 className="gold-text text-3xl font-extrabold tracking-tight sm:text-4xl">
            ليلة المافيا
          </h1>
          <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
            مدير اللعبة الاحترافي بمرشد صوتي عربي
          </p>
        </div>
        <button
          onClick={() => {
            if (!muted) stopSpeaking(true);
            setMuted(!muted);
          }}
          className="surface-card px-3 py-2 text-sm text-foreground transition-transform active:scale-95"
        >
          {muted ? "🔇 الصوت مغلق" : "🔊 الصوت يعمل"}
        </button>
      </header>

      <main className="mx-auto w-full max-w-3xl pb-16">
        {phase === "setup" && (
          <section className="surface-card float-in space-y-6 p-5 sm:p-7">
            <div>
              <h2 className="text-xl font-bold">إعداد اللعبة</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                هاتف واحد يكفي — التطبيق يوزّع الأدوار ويدير الليل بصوت مسموع.
              </p>
            </div>

            <div className="player-count-panel rounded-2xl border p-4 sm:p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <span className="text-sm font-extrabold">عدد اللاعبين</span>
                  <p className="mt-1 text-xs text-muted-foreground">من 4 إلى 16 لاعباً</p>
                </div>
                <span className="emerald-badge flex h-14 min-w-14 items-center justify-center rounded-xl px-3 text-3xl font-black">
                  {playerCount}
                </span>
              </div>
              <div className="grid grid-cols-[44px_1fr_44px] items-center gap-3">
                <StepBtn
                  label="−"
                  onClick={() => setPlayerCount(Math.max(4, playerCount - 1))}
                />
                <div className="grid grid-cols-8 place-items-center gap-1.5 rounded-xl border border-player-accent/30 bg-background/35 p-3 sm:grid-cols-12">
                  {Array.from({ length: playerCount }, (_, i) => (
                    <span
                      key={i}
                      className="player-dot flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-black"
                    >
                      {i + 1}
                    </span>
                  ))}
                </div>
                <StepBtn
                  label="+"
                  onClick={() => setPlayerCount(Math.min(16, playerCount + 1))}
                />
              </div>
              <div className="mt-4 grid grid-cols-7 gap-1.5 sm:grid-cols-13">
                {Array.from({ length: 13 }, (_, i) => i + 4).map((n) => (
                  <button
                    key={n}
                    onClick={() => setPlayerCount(n)}
                    className={`h-9 rounded-lg text-sm font-bold transition active:scale-90 ${
                      n === playerCount
                        ? "emerald-fill"
                        : "border border-border bg-secondary/60 text-muted-foreground"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-sm font-bold">عدد أفراد المافيا</span>
                <span className="text-xs text-muted-foreground">
                  المقترح: {suggestedMafia(playerCount)}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {Array.from(
                  { length: Math.max(1, Math.floor(playerCount / 2) - 1) },
                  (_, i) => i + 1,
                ).map((n) => (
                  <button
                    key={n}
                    onClick={() => setMafiaCount(n)}
                    className={`flex min-w-[74px] flex-1 flex-col items-center gap-1 rounded-xl border px-2 py-3 transition active:scale-95 ${
                      n === mafiaCount
                        ? "royal-fill border-transparent"
                        : "border-border bg-muted/30 text-muted-foreground"
                    }`}
                  >
                    <span className="text-lg leading-none">
                      {"🔪".repeat(Math.min(n, 3))}
                    </span>
                    <span className="text-sm font-extrabold">{n}</span>
                  </button>
                ))}
              </div>
            </div>


            <div className="grid grid-cols-2 gap-3">
              {[
                {
                  on: useDoctor,
                  set: setUseDoctor,
                  role: ROLES.doctor,
                },
                {
                  on: useDetective,
                  set: setUseDetective,
                  role: ROLES.detective,
                },
              ].map(({ on, set, role }) => (
                <button
                  key={role.id}
                  onClick={() => set(!on)}
                  className={`rounded-xl border p-3 text-right transition-all active:scale-95 ${
                    on
                      ? "border-primary bg-secondary"
                      : "border-border bg-muted/40 opacity-60"
                  }`}
                >
                  <div className="text-2xl">{role.emoji}</div>
                  <div className="mt-1 font-bold">{role.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {on ? "مفعّل" : "معطّل"}
                  </div>
                </button>
              ))}
            </div>

            <div>
              <h3 className="mb-2 text-sm font-semibold">أسماء اللاعبين</h3>
              <div className="grid grid-cols-2 gap-2">
                {names.slice(0, playerCount).map((n, i) => (
                  <input
                    key={i}
                    value={n}
                    onChange={(e) => {
                      const copy = [...names];
                      copy[i] = e.target.value;
                      setNames(copy);
                    }}
                    className="rounded-lg border border-border bg-input/40 px-3 py-2 text-sm outline-none focus:border-primary"
                  />
                ))}
              </div>
            </div>

            <button
              onClick={startGame}
              className="gold-fill glow-pulse w-full rounded-xl py-4 text-lg font-extrabold transition-transform active:scale-95"
            >
              ابدأ اللعبة
            </button>
          </section>
        )}

        {phase === "reveal" && players[revealIndex] && (
          <section className="surface-card float-in space-y-5 p-6 text-center">
            <p className="text-sm text-muted-foreground">
              اللاعب {revealIndex + 1} من {players.length}
            </p>
            <h2 className="text-2xl font-extrabold">
              {players[revealIndex].name}
            </h2>
            {!revealShown ? (
              <>
                <p className="text-sm text-muted-foreground">
                  تأكد أن أحداً لا يشاهد الشاشة، ثم اضغط لكشف دورك.
                </p>
                <button
                  onClick={() => setRevealShown(true)}
                  className="gold-fill w-full rounded-xl py-4 text-lg font-bold active:scale-95"
                >
                  اكشف دوري 👁️
                </button>
              </>
            ) : (
              <>
                <div className="rounded-2xl border border-primary/40 bg-secondary p-6">
                  <div className="text-6xl">
                    {ROLES[players[revealIndex].role].emoji}
                  </div>
                  <div className="gold-text mt-3 text-3xl font-extrabold">
                    {ROLES[players[revealIndex].role].name}
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {ROLES[players[revealIndex].role].desc}
                  </p>
                </div>
                <button
                  onClick={nextReveal}
                  disabled={speaking}
                  className="w-full rounded-xl border border-border bg-secondary py-4 font-bold active:scale-95 disabled:opacity-50"
                >
                  {revealIndex + 1 < players.length
                    ? "حفظت دوري — التالي"
                    : "ابدأ الليلة الأولى 🌙"}
                </button>
              </>
            )}
          </section>
        )}

        {phase === "night" && currentStep && (
          <section className="surface-card float-in space-y-5 p-6 text-center">
            <div className="text-5xl">🌙</div>
            <p className="text-xs text-muted-foreground">الليلة {night}</p>
            <h2 className="text-xl font-bold leading-relaxed">
              {currentStep.text}
            </h2>
            {speaking && (
              <p className="gold-text text-sm font-bold">…المرشد يتحدث</p>
            )}

            {awaitingPick && currentStep.action && (
              <div className="space-y-3">
                <PlayerPicker
                  players={alive}
                  selected={nightPick}
                  onSelect={setNightPick}
                  accent={currentStep.action === "mafia" ? "red" : "gold"}
                />
                <button
                  onClick={() => {
                    if (nightPick === null) return;
                    const id = nightPick;
                    setNightPick(null);
                    pick(currentStep, id);
                  }}
                  disabled={nightPick === null}
                  className={`w-full rounded-xl py-4 text-lg font-extrabold transition active:scale-95 disabled:opacity-40 ${
                    currentStep.action === "mafia" ? "royal-fill" : "gold-fill"
                  }`}
                >
                  تأكيد الاختيار
                </button>
                {currentStep.action === "doctor" && (
                  <button
                    onClick={() => {
                      setNightPick(null);
                      pick(currentStep, -1);
                    }}
                    className="w-full rounded-xl border border-border py-3 text-sm text-muted-foreground"
                  >
                    تخطي بلا إنقاذ
                  </button>
                )}
              </div>
            )}


            {detectiveResult && (
              <p className="rounded-lg bg-secondary p-3 text-sm">
                نتيجة التحقيق: {detectiveResult}
              </p>
            )}

            {!speaking && !awaitingPick && (
              <button
                onClick={() => advance()}
                className="w-full rounded-xl border border-border bg-secondary py-3 text-sm"
              >
                تخطي هذه الخطوة
              </button>
            )}
          </section>
        )}

        {phase === "morning" && (
          <section className="surface-card float-in space-y-5 p-6 text-center">
            <div className="text-5xl">☀️</div>
            <h2 className="text-xl font-bold leading-relaxed">{morningText}</h2>
            <p className="text-sm text-muted-foreground">
              تناقشوا الآن، ثم صوّتوا على من تشكّون فيه.
            </p>
            <button
              onClick={startVote}
              className="blood-fill w-full rounded-xl py-4 text-lg font-bold active:scale-95"
            >
              ابدأ التصويت 🗳️
            </button>
          </section>
        )}

        {phase === "vote" && (
          <section className="surface-card float-in space-y-4 p-6">
            <h2 className="text-center text-xl font-bold">التصويت</h2>
            {!voteResult ? (
              <>
                <PlayerPicker
                  players={alive}
                  selected={voteTarget}
                  onSelect={setVoteTarget}
                  accent="red"
                />

                <button
                  onClick={confirmVote}
                  disabled={voteTarget === null}
                  className="gold-fill w-full rounded-xl py-4 text-lg font-bold disabled:opacity-40"
                >
                  تأكيد الإعدام
                </button>
              </>
            ) : (
              <>
                <p className="text-center text-lg font-bold">{voteResult}</p>
                <button
                  onClick={() => startNight(night + 1)}
                  className="w-full rounded-xl border border-border bg-secondary py-4 font-bold active:scale-95"
                >
                  الليلة التالية 🌙
                </button>
              </>
            )}
          </section>
        )}

        {phase === "end" && (
          <section className="surface-card float-in space-y-5 p-6 text-center">
            <div className="text-6xl">{winner === "mafia" ? "🔪" : "🏆"}</div>
            <h2 className="gold-text text-3xl font-extrabold">
              {winner === "mafia" ? "فوز المافيا!" : "فوز المدينة!"}
            </h2>
            <div className="space-y-2 text-right">
              {players.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between rounded-lg bg-secondary px-3 py-2 text-sm"
                >
                  <span>
                    {ROLES[p.role].emoji} {p.name}
                  </span>
                  <span className="text-muted-foreground">
                    {ROLES[p.role].name} — {p.alive ? "حي" : "خارج اللعبة"}
                  </span>
                </div>
              ))}
            </div>
            <button
              onClick={resetAll}
              className="gold-fill w-full rounded-xl py-4 text-lg font-bold active:scale-95"
            >
              لعبة جديدة
            </button>
          </section>
        )}

        {log.length > 0 && phase !== "setup" && (
          <section className="surface-card mt-5 space-y-2 p-4 text-sm">
            <h3 className="font-bold">سجل الأحداث</h3>
            {log.map((l, i) => (
              <p key={i} className="text-muted-foreground">
                {l}
              </p>
            ))}
          </section>
        )}

        {voiceError && !muted && (
          <aside className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-player-accent/40 bg-player-accent/10 p-3 text-sm" role="alert">
            <span>{voiceError}</span>
            <button
              onClick={() => retryNarrationRef.current?.()}
              className="shrink-0 rounded-md border border-player-accent/50 px-3 py-2 font-bold"
            >
              إعادة المحاولة
            </button>
          </aside>
        )}
      </main>
    </div>
  );
}

function PlayerPicker({
  players,
  selected,
  onSelect,
  accent = "gold",
}: {
  players: Player[];
  selected: number | null;
  onSelect: (id: number) => void;
  accent?: "gold" | "red";
}) {
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
      {players.map((p, i) => {
        const on = selected === p.id;
        return (
          <button
            key={p.id}
            onClick={() => onSelect(p.id)}
            className={`group relative flex flex-col items-center gap-2 rounded-2xl border px-2 py-3 transition-all active:scale-95 ${
              on
                ? accent === "red"
                  ? "border-primary bg-primary/15 shadow-[0_0_0_2px_var(--primary)]"
                  : "gold-ring bg-[oklch(0.78_0.16_85_/_0.12)]"
                : "border-border bg-muted/30 hover:border-primary/40"
            }`}
          >
            <span
              className={`flex h-12 w-12 items-center justify-center rounded-full text-lg font-extrabold ${
                on
                  ? accent === "red"
                    ? "royal-fill"
                    : "gold-fill"
                  : "bg-secondary text-foreground/80"
              }`}
            >
              {p.name.trim().charAt(0) || i + 1}
            </span>
            <span className="line-clamp-1 text-xs font-bold">{p.name}</span>
            {on && (
              <span className="absolute end-1.5 top-1.5 text-xs">✓</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function StepBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="gold-ring h-10 w-10 shrink-0 rounded-full bg-secondary text-xl font-extrabold leading-none transition active:scale-90"
    >
      {label}
    </button>
  );
}
