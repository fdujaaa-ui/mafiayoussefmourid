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
  const [mafiaTarget, setMafiaTarget] = useState<number | null>(null);
  const [doctorTarget, setDoctorTarget] = useState<number | null>(null);
  const [detectiveResult, setDetectiveResult] = useState<string | null>(null);
  const [morningText, setMorningText] = useState("");
  const [voteTarget, setVoteTarget] = useState<number | null>(null);
  const [voteResult, setVoteResult] = useState<string | null>(null);
  const [winner, setWinner] = useState<"mafia" | "town" | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const timerRef = useRef<number | null>(null);
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
    speak(text, {
      muted: mutedRef.current,
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
    setPlayers(shuffle(list).map((p, i) => ({ ...p, id: i })));
    setRevealIndex(0);
    setRevealShown(false);
    setLog([]);
    setNight(1);
    setWinner(null);
    setPhase("reveal");
    initNarrator();
    speak("توزّعت الأدوار. مرّروا الهاتف لكل لاعب ليرى دوره سراً.", {
      muted: mutedRef.current,
    });
  }

  /* ---------------- reveal ---------------- */
  function nextReveal() {
    if (revealIndex + 1 < players.length) {
      setRevealIndex(revealIndex + 1);
      setRevealShown(false);
    } else {
      startNight(1);
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
      nightSteps.slice(0, 3).forEach((s) => prefetch(s.text));
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
      const target = players.find((p) => p.id === playerId)!;
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
      text = saved
        ? "المافيا هاجمت أحدهم، لكن الطبيب أنقذه في اللحظة الأخيرة. لم يمت أحد الليلة."
        : "مرّت الليلة بسلام، لم يمت أحد.";
    } else {
      const victim = players.find((p) => p.id === mafiaTarget)!;
      updated = players.map((p) =>
        p.id === mafiaTarget ? { ...p, alive: false } : p,
      );
      text = `في هذا الصباح وجدنا ${victim.name} مقتولاً. كان دوره ${ROLES[victim.role].name}.`;
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
    const target = players.find((p) => p.id === voteTarget)!;
    const updated = players.map((p) =>
      p.id === voteTarget ? { ...p, alive: false } : p,
    );
    setPlayers(updated);
    const text = `تم إعدام ${target.name}. كان دوره ${ROLES[target.role].name}.`;
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
            if (!muted) stopSpeaking();
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

            <div>
              <label className="mb-2 flex items-center justify-between text-sm font-semibold">
                <span>عدد اللاعبين</span>
                <span className="gold-text text-lg font-bold">
                  {playerCount}
                </span>
              </label>
              <input
                type="range"
                min={4}
                max={16}
                value={playerCount}
                onChange={(e) => setPlayerCount(Number(e.target.value))}
                className="w-full accent-primary"
              />
            </div>

            <div>
              <label className="mb-2 flex items-center justify-between text-sm font-semibold">
                <span>عدد أفراد المافيا</span>
                <span className="gold-text text-lg font-bold">{mafiaCount}</span>
              </label>
              <input
                type="range"
                min={1}
                max={Math.max(1, Math.floor(playerCount / 2) - 1)}
                value={mafiaCount}
                onChange={(e) => setMafiaCount(Number(e.target.value))}
                className="w-full accent-primary"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                المقترح: {suggestedMafia(playerCount)}
              </p>
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
                  className="w-full rounded-xl border border-border bg-secondary py-4 font-bold active:scale-95"
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
                <div className="grid grid-cols-2 gap-2">
                  {alive.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => pick(currentStep, p.id)}
                      className="rounded-xl border border-border bg-secondary px-3 py-3 font-semibold active:scale-95"
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
                {currentStep.action === "doctor" && (
                  <button
                    onClick={() => pick(currentStep, -1)}
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
                <div className="grid grid-cols-2 gap-2">
                  {alive.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setVoteTarget(p.id)}
                      className={`rounded-xl border px-3 py-3 font-semibold active:scale-95 ${
                        voteTarget === p.id
                          ? "border-primary bg-secondary"
                          : "border-border bg-muted/40"
                      }`}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
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
      </main>
    </div>
  );
}
