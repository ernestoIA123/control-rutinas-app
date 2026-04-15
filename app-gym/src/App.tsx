import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./lib/supabase";

type SeriesItem = {
  id: number;
  blockId: number;
  routineId: number;
  routineName: string;
  exercise: string;
  reps: number;
  restSeconds: number;
  setNumber: number;
  totalSets: number;
  completed: boolean;
  completedAt?: number;
};

type Routine = {
  id: number;
  name: string;
  createdAt: number;
};

type ValidateAccessResponse = {
  ok: boolean;
  exists?: boolean;
  access_active?: boolean;
  subscription_status?: string;
  plan?: string;
  should_show_paywall?: boolean;
  message?: string;
};

const BACKEND_URL = "https://control-rutinas-backend-production.up.railway.app";
// 🔥 Ya no forzamos redirección automática al login para evitar el parpadeo
const PLAN_NAME = "Plan mensual: control de rutinas";

const neon = "#b7ff31";
const neonSoft = "#eaffb8";
const orangeSoft = "#ffd089";
const dark3 = "#101612";
const panel = "#121916";
const panelSoft = "#17211c";
const border = "#233428";
const text = "#f5fff2";
const muted = "#9cb0a1";
const doneText = "#7f8d83";
const redDone = "#ff4d4f";

const STORAGE_ROUTINES = "gym_routines_v4";
const STORAGE_SERIES = "gym_series_v4";
const STORAGE_ACTIVE = "gym_active_routine_v4";
const STORAGE_REST = "gym_rest_state_v4";

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function formatSeconds(total: number) {
  const safe = Math.max(0, total);
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${pad(minutes)}:${pad(seconds)}`;
}

function groupByRoutine(series: SeriesItem[]) {
  const map = new Map<number, SeriesItem[]>();

  for (const item of series) {
    if (!map.has(item.routineId)) map.set(item.routineId, []);
    map.get(item.routineId)!.push(item);
  }

  for (const [, items] of map) {
    items.sort((a, b) => a.setNumber - b.setNumber);
  }

  return map;
}

function getNextPending(items: SeriesItem[]) {
  return items.find((item) => !item.completed) || null;
}

function getNextRoutine(
  routines: Routine[],
  grouped: Map<number, SeriesItem[]>,
  currentId: number | null
) {
  const ordered = routines.slice().sort((a, b) => a.createdAt - b.createdAt);
  if (ordered.length === 0) return null;

  const currentIndex = ordered.findIndex((r) => r.id === currentId);
  const start = currentIndex >= 0 ? currentIndex + 1 : 0;

  for (let i = start; i < ordered.length; i++) {
    const candidate = ordered[i];
    const items = grouped.get(candidate.id) || [];
    if (items.some((item) => !item.completed)) return candidate;
  }

  for (let i = 0; i < ordered.length; i++) {
    const candidate = ordered[i];
    const items = grouped.get(candidate.id) || [];
    if (items.some((item) => !item.completed)) return candidate;
  }

  return null;
}

export default function App() {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [series, setSeries] = useState<SeriesItem[]>([]);
  const [activeRoutineId, setActiveRoutineId] = useState<number | null>(null);
  const [showRoutineModal, setShowRoutineModal] = useState(false);

  const [exerciseName, setExerciseName] = useState("");
  const [reps, setReps] = useState("12");
  const [restValue, setRestValue] = useState("1");
  const [restUnit, setRestUnit] = useState<"minutes" | "seconds">("minutes");
  const [showRestPicker, setShowRestPicker] = useState(false);
  const [sets, setSets] = useState("4");

  const [resting, setResting] = useState(false);
  const [restRemaining, setRestRemaining] = useState(0);
  const [restTargetSeriesId, setRestTargetSeriesId] = useState<number | null>(null);
  const [lastCompletedSeriesId, setLastCompletedSeriesId] = useState<number | null>(null);
  const [absorbingSeriesId, setAbsorbingSeriesId] = useState<number | null>(null);
  const [pulseTick, setPulseTick] = useState(0);
  const [showCompleted, setShowCompleted] = useState(false);

  const [checkingAccess, setCheckingAccess] = useState(true);
  const [hasAccess, setHasAccess] = useState(false);
  const [paying, setPaying] = useState(false);
  const [accessMessage, setAccessMessage] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [emailInput, setEmailInput] = useState("");

  const timerRef = useRef<number | null>(null);
  const queueAnchorRef = useRef<HTMLDivElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  async function validateAccess(emailToCheck?: string) {
    const cleanEmail = (emailToCheck || emailInput || userEmail).trim().toLowerCase();

    if (!cleanEmail) {
      setHasAccess(false);
      setCheckingAccess(false);
      setAccessMessage("No hay sesión activa. Inicia sesión primero.");
      return;
    }

    try {
      setCheckingAccess(true);
      setAccessMessage("");
      setUserEmail(cleanEmail);
      setEmailInput(cleanEmail);

      const response = await fetch(`${BACKEND_URL}/validate-access`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: cleanEmail }),
      });

      const data: ValidateAccessResponse = await response.json();

      if (!response.ok) {
        throw new Error(data?.message || "No se pudo validar el acceso.");
      }

      const active = Boolean(data?.access_active);
      setHasAccess(active);

      if (!active) {
        setAccessMessage(
          data?.message || "Tu plan mensual no está activo. Actívalo para usar la app web."
        );
      } else {
        setAccessMessage("");
      }
    } catch (error) {
      console.error("Error validando acceso:", error);
      setHasAccess(false);
      setAccessMessage("No se pudo validar tu acceso. Intenta de nuevo.");
    } finally {
      setCheckingAccess(false);
    }
  }

  async function handleStartCheckout() {
    const cleanEmail = (emailInput || userEmail).trim().toLowerCase();

    if (!cleanEmail) {
      alert("Escribe tu correo antes de continuar al pago.");
      return;
    }

    try {
      setPaying(true);
      setUserEmail(cleanEmail);
      setEmailInput(cleanEmail);

      const response = await fetch(`${BACKEND_URL}/create-checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: cleanEmail }),
      });

      const data = await response.json();

      if (!response.ok || !data?.checkout_url) {
        throw new Error(data?.detail || "No se pudo crear la sesión de pago.");
      }

      window.location.href = data.checkout_url;
    } catch (error) {
      console.error("Error creando checkout:", error);
      alert("No se pudo abrir Stripe. Intenta otra vez.");
      setPaying(false);
    }
  }

  async function handleLogout() {
    try {
      await supabase.auth.signOut();
    } catch (error) {
      console.error("Error cerrando sesión:", error);
    }

    setHasAccess(false);
    setCheckingAccess(false);
    setAccessMessage("Sesión cerrada. Inicia sesión otra vez.");
    setUserEmail("");
    setEmailInput("");
  }

  useEffect(() => {
    let isMounted = true;

    const checkUser = async () => {
      try {
        const { data, error } = await supabase.auth.getSession();

        if (error) {
          throw error;
        }

        const session = data.session;

        if (!isMounted) return;

        if (!session) {
          setHasAccess(false);
          setCheckingAccess(false);
          setAccessMessage("No hay sesión activa. Inicia sesión primero.");
          return;
        }

        const email = session.user.email?.trim().toLowerCase() || "";

        if (!email) {
          setHasAccess(false);
          setCheckingAccess(false);
          setAccessMessage("No pudimos detectar tu correo de sesión.");
          return;
        }

        setUserEmail(email);
        setEmailInput(email);
        await validateAccess(email);
      } catch (error) {
        console.error("Error revisando sesión:", error);

        if (!isMounted) return;

        setHasAccess(false);
        setCheckingAccess(false);
        setAccessMessage("No se pudo revisar tu sesión.");
      }
    };

    checkUser();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!isMounted) return;

      if (!session) {
        setHasAccess(false);
        setCheckingAccess(false);
        setAccessMessage("Tu sesión se cerró. Inicia sesión otra vez.");
        setUserEmail("");
        setEmailInput("");
        return;
      }

      const email = session.user.email?.trim().toLowerCase() || "";
      setUserEmail(email);
      setEmailInput(email);

      if (email) {
        validateAccess(email);
      } else {
        setHasAccess(false);
        setCheckingAccess(false);
        setAccessMessage("No pudimos detectar tu correo de sesión.");
      }
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const checkoutStatus = params.get("checkout");

    if (checkoutStatus === "success") {
      setAccessMessage("Pago detectado. Estamos validando tu acceso.");
    }
  }, []);

  useEffect(() => {
    try {
      const savedRoutines = localStorage.getItem(STORAGE_ROUTINES);
      const savedSeries = localStorage.getItem(STORAGE_SERIES);
      const savedActiveRoutineId = localStorage.getItem(STORAGE_ACTIVE);
      const savedRest = localStorage.getItem(STORAGE_REST);

      if (savedRoutines) setRoutines(JSON.parse(savedRoutines));
      if (savedSeries) setSeries(JSON.parse(savedSeries));
      if (savedActiveRoutineId) setActiveRoutineId(JSON.parse(savedActiveRoutineId));

      if (savedRest) {
        const parsed = JSON.parse(savedRest);
        if (parsed?.resting && typeof parsed?.endAt === "number") {
          const secondsLeft = Math.max(0, Math.ceil((parsed.endAt - Date.now()) / 1000));
          if (secondsLeft > 0) {
            setResting(true);
            setRestRemaining(secondsLeft);
            setRestTargetSeriesId(parsed.restTargetSeriesId ?? null);
            setLastCompletedSeriesId(parsed.lastCompletedSeriesId ?? null);
          }
        }
      }
    } catch (error) {
      console.error("Error cargando datos:", error);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_ROUTINES, JSON.stringify(routines));
  }, [routines]);

  useEffect(() => {
    localStorage.setItem(STORAGE_SERIES, JSON.stringify(series));
  }, [series]);

  useEffect(() => {
    localStorage.setItem(STORAGE_ACTIVE, JSON.stringify(activeRoutineId));
  }, [activeRoutineId]);

  useEffect(() => {
    if (!resting || restRemaining <= 0) {
      localStorage.removeItem(STORAGE_REST);
      return;
    }

    localStorage.setItem(
      STORAGE_REST,
      JSON.stringify({
        resting: true,
        endAt: Date.now() + restRemaining * 1000,
        restTargetSeriesId,
        lastCompletedSeriesId,
      })
    );
  }, [resting, restRemaining, restTargetSeriesId, lastCompletedSeriesId]);

  useEffect(() => {
    if (!resting) {
      if (timerRef.current) window.clearInterval(timerRef.current);
      timerRef.current = null;
      return;
    }

    if (timerRef.current) window.clearInterval(timerRef.current);

    timerRef.current = window.setInterval(() => {
      setRestRemaining((prev) => {
        if (prev <= 1) {
          if (timerRef.current) window.clearInterval(timerRef.current);
          timerRef.current = null;

          playSeriesDoneBeep();
          setResting(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [resting]);

  const grouped = useMemo(() => groupByRoutine(series), [series]);

  const orderedRoutines = useMemo(() => {
    return routines.slice().sort((a, b) => a.createdAt - b.createdAt);
  }, [routines]);

  const currentRoutine = useMemo(() => {
    if (activeRoutineId === null) return null;
    return routines.find((item) => item.id === activeRoutineId) || null;
  }, [routines, activeRoutineId]);

  const currentSeries = useMemo(() => {
    if (activeRoutineId === null) return [];
    return (grouped.get(activeRoutineId) || []).slice().sort((a, b) => a.id - b.id);
  }, [grouped, activeRoutineId]);

  const nextSeries = useMemo(() => getNextPending(currentSeries), [currentSeries]);

  const currentRoutineDone =
    !!currentRoutine &&
    currentSeries.length > 0 &&
    currentSeries.every((item) => item.completed);

  const nextRoutine = useMemo(
    () => getNextRoutine(orderedRoutines, grouped, activeRoutineId),
    [orderedRoutines, grouped, activeRoutineId]
  );

  const activeExerciseSeries = useMemo(() => {
    if (!currentRoutine) return [];

    const pending = currentSeries
      .filter((item) => !item.completed)
      .sort((a, b) => a.id - b.id);

    if (pending.length === 0) return [];

    const firstBlockId = pending[0].blockId;
    return pending.filter((item) => item.blockId === firstBlockId);
  }, [currentRoutine, currentSeries]);

  const orderedIncomingSeries = useMemo(() => {
    if (!currentRoutine) return [];
    return [...activeExerciseSeries].sort((a, b) => b.setNumber - a.setNumber);
  }, [currentRoutine, activeExerciseSeries]);

  const waitingExercisesTop = useMemo(() => {
    if (!currentRoutine) return [];

    const pending = currentSeries
      .filter((item) => !item.completed)
      .sort((a, b) => a.id - b.id);

    if (pending.length === 0) return [];

    const activeBlockId = pending[0].blockId;
    const blocks: SeriesItem[][] = [];
    let currentBlock: SeriesItem[] = [];

    for (const item of pending) {
      if (item.blockId === activeBlockId) continue;

      if (currentBlock.length === 0) {
        currentBlock.push(item);
        continue;
      }

      if (currentBlock[0].blockId === item.blockId) {
        currentBlock.push(item);
      } else {
        blocks.push(currentBlock);
        currentBlock = [item];
      }
    }

    if (currentBlock.length > 0) {
      blocks.push(currentBlock);
    }

    return blocks.map((items) => {
      const first = items[0];
      return {
        blockId: first.blockId,
        exercise: first.exercise,
        routineName: first.routineName,
        reps: first.reps,
        restSeconds: first.restSeconds,
        totalSets: items.length,
      };
    });
  }, [currentRoutine, currentSeries]);

  const completedSeries = useMemo(() => {
    if (!currentRoutine) return [];
    return currentSeries
      .filter((item) => item.completed)
      .sort((a, b) => (a.completedAt || 0) - (b.completedAt || 0));
  }, [currentRoutine, currentSeries]);

  function resetRoutineForm() {
    setExerciseName("");
    setReps("12");
    setRestValue("1");
    setRestUnit("minutes");
    setShowRestPicker(false);
    setSets("4");
  }

  function openCreateRoutine() {
    resetRoutineForm();
    setShowRoutineModal(true);
  }

  function saveRoutine() {
    const cleanExercise = exerciseName.trim();
    const repsNum = Math.max(1, Number(reps));
    const restBaseNum = Math.max(1, Number(restValue));
    const restNum = restUnit === "minutes" ? restBaseNum * 60 : restBaseNum;
    const setsNum = Math.max(1, Number(sets));

    if (!cleanExercise) return alert("Escribe el nombre del ejercicio");
    if (!Number.isFinite(repsNum) || repsNum < 1) return alert("Las repeticiones deben ser válidas");
    if (!Number.isFinite(restBaseNum) || restBaseNum < 1) return alert("El descanso debe ser válido");
    if (!Number.isFinite(setsNum) || setsNum < 1) return alert("Las series deben ser válidas");

    const now = Date.now();
    const routineId = activeRoutineId ?? now;
    const createdAt = now;

    const activeRoutine = routines.find((r) => r.id === activeRoutineId);
    const routineNameToUse = activeRoutine?.name || `Rutina ${routines.length + 1}`;

    if (!activeRoutine) {
      setRoutines((prev) => [
        ...prev,
        { id: routineId, name: routineNameToUse, createdAt },
      ]);
      setActiveRoutineId(routineId);
    }

    const blockId = createdAt;

    const newSeries: SeriesItem[] = Array.from({ length: setsNum }).map((_, index) => ({
      id: createdAt + index + 1,
      blockId,
      routineId,
      routineName: routineNameToUse,
      exercise: cleanExercise,
      reps: repsNum,
      restSeconds: restNum,
      setNumber: index + 1,
      totalSets: setsNum,
      completed: false,
    }));

    setSeries((prev) => [...prev, ...newSeries]);
    setShowRoutineModal(false);
    resetRoutineForm();
  }

  function startRoutine(routineId: number) {
    setActiveRoutineId(routineId);
    setResting(false);
    setRestRemaining(0);
    setRestTargetSeriesId(null);
    setLastCompletedSeriesId(null);
    setAbsorbingSeriesId(null);
    setShowCompleted(false);
  }

  function startNextRoutine() {
    if (!nextRoutine) return;
    startRoutine(nextRoutine.id);
  }

  function goBackToEmptyState() {
    setActiveRoutineId(null);
    setRoutines([]);
    setSeries([]);
    setResting(false);
    setRestRemaining(0);
    setRestTargetSeriesId(null);
    setLastCompletedSeriesId(null);
    setAbsorbingSeriesId(null);
    setShowCompleted(false);

    localStorage.removeItem(STORAGE_ROUTINES);
    localStorage.removeItem(STORAGE_SERIES);
    localStorage.removeItem(STORAGE_ACTIVE);
    localStorage.removeItem(STORAGE_REST);
  }

  function playSeriesDoneBeep() {
    try {
      const AudioCtx =
        window.AudioContext || (window as any).webkitAudioContext;

      if (!AudioCtx) return;

      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioCtx();
      }

      const ctx = audioCtxRef.current;

      if (ctx.state === "suspended") {
        ctx.resume();
      }

      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();

      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(880, ctx.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(1180, ctx.currentTime + 0.08);

      gainNode.gain.setValueAtTime(0.0001, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.01);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.16);

      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);

      oscillator.start(ctx.currentTime);
      oscillator.stop(ctx.currentTime + 0.17);
    } catch (error) {
      console.error("No se pudo reproducir el sonido:", error);
    }
  }

  function finishSeries(item: SeriesItem) {
    if (resting || absorbingSeriesId !== null) return;

    playSeriesDoneBeep();
    setAbsorbingSeriesId(item.id);

    setTimeout(() => {
      setSeries((prev) =>
        prev.map((row) =>
          row.id === item.id ? { ...row, completed: true, completedAt: Date.now() } : row
        )
      );

      const routineItems = (grouped.get(item.routineId) || [])
        .slice()
        .sort((a, b) => a.setNumber - b.setNumber);

      const next = routineItems.find((row) => !row.completed && row.id !== item.id);

      setLastCompletedSeriesId(item.id);
      setAbsorbingSeriesId(null);
      setPulseTick((prev) => prev + 1);

      if (next && item.restSeconds > 0) {
        setResting(true);
        setRestRemaining(item.restSeconds);
        setRestTargetSeriesId(next.id);
        return;
      }

      setResting(false);
      setRestRemaining(0);
      setRestTargetSeriesId(null);
    }, 100);
  }

  function skipRest() {
    setResting(false);
    setRestRemaining(0);
  }

  function scrollToBottom() {
    window.scrollTo({
      top: document.body.scrollHeight,
      behavior: "smooth",
    });
  }

  if (checkingAccess) {
    return (
      <div style={pageStyle}>
        <div style={paywallShellStyle}>
          <div style={paywallCardStyle}>
            <div style={paywallBadgeStyle}>VALIDANDO ACCESO</div>
            <h1 style={paywallTitleStyle}>Control de rutinas</h1>
            <p style={paywallTextStyle}>
              Estamos revisando si tu plan mensual está activo.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!hasAccess) {
    return (
      <div style={pageStyle}>
        <div style={paywallShellStyle}>
          <div style={paywallCardStyle}>
            <div style={paywallBadgeStyle}>ACCESO BLOQUEADO</div>

            <h1 style={paywallTitleStyle}>Activa tu plan mensual</h1>

            <p style={paywallTextStyle}>
              Tu suscripción no está activa. Para usar la app web, activa tu{" "}
              <strong>{PLAN_NAME}</strong>.
            </p>

            <div style={paywallPlanBoxStyle}>
              <div style={paywallPlanLabelStyle}>PLAN</div>
              <div style={paywallPlanNameStyle}>{PLAN_NAME}</div>
              <div style={paywallPlanPriceStyle}>5 USD / mes</div>
            </div>

            <input
              type="email"
              placeholder="Escribe tu correo"
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              style={paywallInputStyle}
            />

            {accessMessage ? (
              <div style={paywallMessageStyle}>{accessMessage}</div>
            ) : null}

            <div style={paywallButtonsWrapStyle}>
              <button
                onClick={() => validateAccess(emailInput)}
                style={secondaryButtonStyle}
              >
                REVISAR ACCESO
              </button>

              <button
                onClick={handleStartCheckout}
                disabled={paying}
                style={{
                  ...primaryButtonStyle,
                  opacity: paying ? 0.75 : 1,
                }}
              >
                {paying ? "ABRIENDO PAGO..." : "PAGAR PLAN MENSUAL"}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
    return (
    <div style={pageStyle}>
      <button
        onClick={handleLogout}
        style={{
          position: "fixed",
          top: 20,
          right: 20,
          background: "#ff4d4f",
          color: "#fff",
          border: "none",
          padding: "10px 14px",
          borderRadius: 10,
          fontWeight: 800,
          cursor: "pointer",
          zIndex: 999,
          boxShadow: "0 6px 0 #8f1f20",
        }}
      >
        Cerrar sesión
      </button>

      <div style={{ maxWidth: 520, margin: "0 auto" }}>
        <div style={heroStyle}>
          <div>
            <div style={{ color: neon, fontSize: 12, fontWeight: 900, letterSpacing: 1.3 }}>
              EMBUDO DE SERIES
            </div>
            <h1 style={{ margin: "8px 0 6px", color: text, fontSize: 30, lineHeight: 1.05 }}>
              Todo baja al cuadro principal
            </h1>
            <p style={{ margin: 0, color: muted, fontSize: 14 }}>
              Las rutinas en espera muestran solo una tarjeta naranja. Cuando llega su turno, se despliegan sus series verdes.
            </p>
          </div>
        </div>

        {waitingExercisesTop.length > 0 && (
          <>
            <div style={sectionTitleStyle}>Siguientes ejercicios</div>
            {[...waitingExercisesTop].reverse().map((item) => (
              <div
                key={item.blockId}
                style={{
                  ...routineQueueOrangeCardStyle,
                  border: `2px solid ${orangeSoft}`,
                }}
              >
                <div
                  style={{
                    ...routineMiniOrangeStyle,
                    background: "#e5e5e5",
                    color: "#000000",
                  }}
                >
                  SIGUIENTE EJERCICIO
                </div>

                <div
                  style={{
                    color: "#000000",
                    fontWeight: 1000,
                    fontSize: 28,
                    lineHeight: 1.02,
                  }}
                >
                  {item.exercise}
                </div>

                <div
                  style={{
                    color: "#2f1a06",
                    marginTop: 8,
                    fontSize: 16,
                    fontWeight: 900,
                  }}
                >
                  Ejercicio
                </div>

                <div
                  style={{
                    color: "#5c3510",
                    marginTop: 6,
                    fontSize: 14,
                    fontWeight: 800,
                  }}
                >
                  {item.totalSets} series · {item.reps} reps · descanso {item.restSeconds}s
                </div>
              </div>
            ))}
          </>
        )}

        {currentRoutine && orderedIncomingSeries.length > 0 && (
          <div style={sectionTitleStyle}>Ejercicios en fila</div>
        )}

        {currentRoutine &&
          orderedIncomingSeries
            .filter((item) => item.id !== nextSeries?.id || item.id === absorbingSeriesId)
            .map((item) => {
              const isCurrent = item.id === nextSeries?.id;
              const isWaiting = restTargetSeriesId === item.id;
              const isAbsorbing = absorbingSeriesId === item.id;

              return (
                <div
                  key={item.id}
                  ref={item === orderedIncomingSeries[0] ? queueAnchorRef : null}
                  style={{
                    ...uniformGreenCardStyle,
                    border: isCurrent ? `2px solid ${neonSoft}` : `1px solid ${border}`,
                    animation: isAbsorbing
                      ? "absorbDown 0.1s cubic-bezier(0.3, 1, 0.4, 1) forwards"
                      : undefined,
                    opacity: 1,
                    willChange: isAbsorbing ? "transform, opacity, filter" : undefined,
                    backfaceVisibility: "hidden",
                    transform: isAbsorbing ? "translateZ(0) scale(1.02)" : "translateZ(0)",
                  }}
                >
                  <div
                    style={{
                      color: "#000000",
                      fontWeight: 1000,
                      fontSize: 30,
                      lineHeight: 1.02,
                    }}
                  >
                    {item.exercise}
                  </div>

                  <div
                    style={{
                      color: "#000000",
                      marginTop: 10,
                      fontWeight: 900,
                      fontSize: 18,
                    }}
                  >
                    Serie {item.setNumber}/{item.totalSets}
                  </div>

                  <div
                    style={{
                      color: "#1b2b12",
                      marginTop: 7,
                      fontSize: 18,
                      fontWeight: 900,
                    }}
                  >
                    {item.reps} reps · descanso {item.restSeconds}s
                  </div>

                  <div
                    style={{
                      marginTop: 12,
                      color: "#000000",
                      fontWeight: 900,
                      fontSize: 13,
                      letterSpacing: 0.3,
                    }}
                  >
                    {isAbsorbing
                      ? "ABSORBIENDO..."
                      : isWaiting
                      ? "SIGUE DESPUÉS DEL DESCANSO"
                      : isCurrent
                      ? "SIGUIENTE EN ENTRAR"
                      : "EN RUTINA ACTIVA"}
                  </div>
                </div>
              );
            })}

        <div style={funnelWrapStyle}>
          <div style={funnelNeckStyle} />

          <div
            style={{
              ...mainFrameStyle,
              animation: pulseTick > 0 ? "funnelPulse 0.38s ease" : undefined,
            }}
          >
            <div style={frameHeaderStyle}>CUADRO PRINCIPAL</div>

            {!currentRoutine && orderedRoutines.length === 0 && (
              <div style={centerCardStyle}>
                <div style={{ color: text, fontSize: 24, fontWeight: 900, marginBottom: 8 }}>
                  No hay ejercicios todavía
                </div>
                <div style={{ color: muted, marginBottom: 18 }}>
                  Empieza creando tu primer ejercicio.
                </div>
                <button
                  onClick={() => {
                    openCreateRoutine();
                    scrollToBottom();
                  }}
                  style={primaryButtonStyle}
                >
                  CREAR SIGUIENTE EJERCICIO
                </button>
              </div>
            )}

            {!currentRoutine && orderedRoutines.length > 0 && nextRoutine && (
              <div style={centerCardStyle}>
                <div style={routineMiniStyle}>{nextRoutine.name}</div>
                <div style={{ color: text, fontSize: 28, fontWeight: 900, marginBottom: 8 }}>
                  Preparada para entrar
                </div>
                <div style={{ color: muted, marginBottom: 18 }}>
                  El cuadro principal solo muestra el ejercicio actual.
                </div>
                <button
                  onClick={() => {
                    startRoutine(nextRoutine.id);
                    scrollToBottom();
                  }}
                  style={primaryButtonStyle}
                >
                  Empezar rutina
                </button>
              </div>
            )}

            {currentRoutine && !currentRoutineDone && nextSeries && (
              <div style={centerCardStyle}>
                {!resting && (
                  <>
                    <div style={{ color: text, fontSize: 28, fontWeight: 900, marginBottom: 8 }}>
                      {nextSeries.exercise}
                    </div>

                    <div style={{ ...currentSeriesNumberStyle, lineHeight: 1.4 }}>
                      REALIZANDO SERIE {nextSeries.setNumber}
                    </div>
                  </>
                )}

                <div style={{ color: muted, marginBottom: 14, fontSize: 16, fontWeight: 800 }}>
                  {nextSeries.reps} repeticiones · descanso {nextSeries.restSeconds}s
                </div>

                <button
                  onClick={() => {
                    setShowCompleted((prev) => !prev);
                    scrollToBottom();
                  }}
                  style={{
                    background: "linear-gradient(180deg, #f2f2f2 0%, #dcdcdc 100%)",
                    color: "#333333",
                    border: "1px solid #cfcfcf",
                    padding: "12px 14px",
                    borderRadius: 16,
                    fontWeight: 900,
                    cursor: "pointer",
                    marginBottom: 12,
                    boxShadow: "0 6px 0 #b5b5b5",
                  }}
                >
                  {showCompleted ? "OCULTAR REALIZADAS" : "VER REALIZADAS"}
                </button>

                <button
                  onClick={() => {
                    openCreateRoutine();
                    scrollToBottom();
                  }}
                  style={{
                    background: "linear-gradient(180deg, #4da3ff 0%, #1f6fff 100%)",
                    color: "#ffffff",
                    border: "none",
                    padding: "13px 18px",
                    borderRadius: 16,
                    fontWeight: 900,
                    cursor: "pointer",
                    marginBottom: 12,
                    boxShadow: "0 8px 0 #0f3d91, 0 18px 24px rgba(0,0,0,0.25)",
                  }}
                >
                  + CREAR SIGUIENTE EJERCICIO
                </button>

                {resting ? (
                  <div style={restBoxStyle}>
                    <div style={{ color: neon, fontSize: 12, fontWeight: 900, letterSpacing: 1.2 }}>
                      DESCANSO
                    </div>
                    <div
                      style={{
                        color: text,
                        fontSize: 46,
                        fontWeight: 900,
                        lineHeight: 1,
                        margin: "8px 0 14px",
                      }}
                    >
                      {formatSeconds(restRemaining)}
                    </div>
                    <button
                      onClick={() => {
                        skipRest();
                        window.setTimeout(() => {
                          scrollToBottom();
                        }, 80);
                      }}
                      style={{
                        background: "linear-gradient(180deg, #ff4d4f 0%, #b30000 100%)",
                        color: "#ffffff",
                        border: "none",
                        padding: "12px 14px",
                        borderRadius: 16,
                        fontWeight: 900,
                        cursor: "pointer",
                        boxShadow: "0 6px 0 #660000, 0 12px 18px rgba(0,0,0,0.25)",
                      }}
                    >
                      SALTAR DESCANSO
                    </button>
                  </div>
                ) : nextSeries.setNumber === nextSeries.totalSets ? (
                  <button
                    onClick={() => {
                      finishSeries(nextSeries);

                      requestAnimationFrame(() => {
                        setTimeout(() => {
                          window.scrollTo({
                            top: document.body.scrollHeight,
                            behavior: "smooth",
                          });
                        }, 120);
                      });
                    }}
                    style={{
                      ...primaryButtonStyle,
                      padding: "72px 18px",
                      fontSize: 18,
                      borderRadius: 22,
                      background: "linear-gradient(180deg, #ffb347 0%, #ff8c1a 100%)",
                      boxShadow: "0 8px 0 #a55407, 0 18px 24px rgba(0,0,0,0.22)",
                    }}
                  >
                    EMPEZAR SIGUIENTE EJERCICIO
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      finishSeries(nextSeries);
                      scrollToBottom();
                    }}
                    style={{
                      ...primaryButtonStyle,
                      padding: "72px 18px",
                      fontSize: 16,
                      fontWeight: 900,
                      borderRadius: 22,
                    }}
                  >
                    Finalizar serie {nextSeries.setNumber}
                  </button>
                )}
              </div>
            )}

            {currentRoutine && currentRoutineDone && (
              <div style={{ ...centerCardStyle, animation: "funnelPulse 0.38s ease" }}>
                <div style={{ color: text, fontSize: 28, fontWeight: 900, marginBottom: 10 }}>
                  {currentRoutine.name} FINALIZADA
                </div>
                <div style={{ color: muted, marginBottom: 18 }}>
                  Esta rutina ya pasó por el embudo completo.
                </div>
                {nextRoutine ? (
                  <button
                    onClick={() => {
                      startNextRoutine();
                      scrollToBottom();
                    }}
                    style={primaryButtonStyle}
                  >
                    Empezar rutina
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      goBackToEmptyState();
                      scrollToBottom();
                    }}
                    style={{
                      background: "linear-gradient(180deg, #f2f2f2 0%, #dcdcdc 100%)",
                      color: "#333333",
                      border: "1px solid #cfcfcf",
                      padding: "12px 14px",
                      borderRadius: 16,
                      fontWeight: 900,
                      cursor: "pointer",
                      boxShadow: "0 6px 0 #b5b5b5",
                    }}
                  >
                    VOLVER
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {currentRoutine && showCompleted && (
          <>
            <div style={sectionTitleStyle}>Finalizados</div>
            {completedSeries.length === 0 ? (
              <div style={emptyStyle}>Cuando finalices una serie aparecerá aquí apagada.</div>
            ) : (
              completedSeries.map((item) => (
                <div
                  key={item.id}
                  style={{
                    ...uniformDoneCardStyle,
                    animation: lastCompletedSeriesId === item.id ? "funnelPulse 0.38s ease" : undefined,
                  }}
                >
                  <div style={routineMiniDoneStyle}>{item.routineName}</div>

                  <div
                    style={{
                      color: doneText,
                      fontWeight: 1000,
                      fontSize: 30,
                      lineHeight: 1.02,
                    }}
                  >
                    {item.exercise}
                  </div>

                  <div
                    style={{
                      color: redDone,
                      marginTop: 10,
                      fontSize: 18,
                      fontWeight: 900,
                    }}
                  >
                    FINALIZADA · Serie {item.setNumber}/{item.totalSets}
                  </div>

                  <div
                    style={{
                      color: "#78857d",
                      marginTop: 7,
                      fontSize: 18,
                      fontWeight: 900,
                    }}
                  >
                    {item.reps} reps · descanso {item.restSeconds}s
                  </div>
                </div>
              ))
            )}
          </>
        )}
      </div>

      {showRoutineModal && (
        <div style={modalOverlayStyle}>
          <div style={modalStyle}>
            <div style={{ color: text, fontSize: 28, fontWeight: 900, marginBottom: 6 }}>
              Crear siguiente ejercicio
            </div>
            <div style={{ color: muted, fontSize: 14, marginBottom: 18 }}>
              Llena cada número según lo que harás en el gym.
            </div>

            <input
              placeholder="Nombre del ejercicio"
              value={exerciseName}
              onChange={(e) => setExerciseName(e.target.value)}
              style={inputStyle}
            />

            <div style={numberFieldsGridStyle}>
              <div style={numberFieldWrapStyle}>
                <input
                  placeholder="4"
                  value={sets}
                  onChange={(e) => setSets(e.target.value.replace(/\D/g, ""))}
                  style={numberInputStyle}
                />
                <div style={numberFieldLabelStyle}>Series</div>
              </div>

              <div style={numberFieldWrapStyle}>
                <input
                  placeholder="12"
                  value={reps}
                  onChange={(e) => setReps(e.target.value.replace(/\D/g, ""))}
                  style={numberInputStyle}
                />
                <div style={numberFieldLabelStyle}>Repeticiones</div>
              </div>

              <div style={{ ...numberFieldWrapStyle, alignItems: "stretch", position: "relative" }}>
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "stretch",
                    width: "100%",
                    height: "100%",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setShowRestPicker((prev) => !prev)}
                    style={{
                      ...numberInputStyle,
                      margin: 0,
                      flex: 1,
                      height: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: "pointer",
                    }}
                  >
                    {restValue}
                  </button>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateRows: "1fr 1fr",
                      gap: 6,
                      width: 70,
                      height: "100%",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setRestUnit("minutes")}
                      style={{
                        border: "none",
                        borderRadius: 12,
                        fontWeight: 900,
                        fontSize: 13,
                        cursor: "pointer",
                        background:
                          restUnit === "minutes"
                            ? "linear-gradient(180deg, #b7ff31 0%, #88ea16 100%)"
                            : "linear-gradient(180deg, #1a211d 0%, #111612 100%)",
                        color: restUnit === "minutes" ? "#0f190b" : text,
                        boxShadow:
                          restUnit === "minutes"
                            ? "0 4px 0 #3f7010"
                            : "0 4px 0 #090c0a",
                      }}
                    >
                      MIN
                    </button>

                    <button
                      type="button"
                      onClick={() => setRestUnit("seconds")}
                      style={{
                        border: "none",
                        borderRadius: 12,
                        fontWeight: 900,
                        fontSize: 13,
                        cursor: "pointer",
                        background:
                          restUnit === "seconds"
                            ? "linear-gradient(180deg, #b7ff31 0%, #88ea16 100%)"
                            : "linear-gradient(180deg, #1a211d 0%, #111612 100%)",
                        color: restUnit === "seconds" ? "#0f190b" : text,
                        boxShadow:
                          restUnit === "seconds"
                            ? "0 4px 0 #3f7010"
                            : "0 4px 0 #090c0a",
                      }}
                    >
                      SEG
                    </button>
                  </div>
                </div>

                <div style={numberFieldLabelStyle}>Descanso</div>

                {showRestPicker && (
                  <div
                    style={{
                      position: "absolute",
                      top: "calc(100% + 8px)",
                      left: 0,
                      right: 0,
                      maxHeight: 220,
                      overflowY: "auto",
                      borderRadius: 16,
                      background: "linear-gradient(180deg, #121815 0%, #0e1310 100%)",
                      border: `1px solid ${border}`,
                      boxShadow: "0 18px 30px rgba(0,0,0,0.35)",
                      padding: 8,
                      zIndex: 50,
                    }}
                  >
                    {Array.from({ length: 60 }, (_, i) => i + 1).map((value) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => {
                          setRestValue(String(value));
                          setShowRestPicker(false);
                        }}
                        style={{
                          width: "100%",
                          border: "none",
                          borderRadius: 12,
                          padding: "12px 10px",
                          marginBottom: 6,
                          fontWeight: 900,
                          fontSize: 14,
                          textAlign: "center",
                          cursor: "pointer",
                          background:
                            restValue === String(value)
                              ? "linear-gradient(180deg, #b7ff31 0%, #88ea16 100%)"
                              : "linear-gradient(180deg, #1a211d 0%, #111612 100%)",
                          color: restValue === String(value) ? "#0f190b" : text,
                          boxShadow:
                            restValue === String(value)
                              ? "0 4px 0 #3f7010"
                              : "0 4px 0 #090c0a",
                        }}
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
              <button
                onClick={() => {
                  setShowRoutineModal(false);
                  resetRoutineForm();
                }}
                style={{
                  flex: 1,
                  background: "linear-gradient(180deg, #ff4d4f 0%, #b30000 100%)",
                  color: "#ffffff",
                  border: "none",
                  padding: "12px 14px",
                  borderRadius: 16,
                  fontWeight: 900,
                  cursor: "pointer",
                  boxShadow: "0 6px 0 #660000, 0 12px 18px rgba(0,0,0,0.25)",
                }}
              >
                CERRAR
              </button>
              <button onClick={saveRoutine} style={{ ...primaryButtonStyle, flex: 1 }}>
                GUARDAR
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
  @keyframes absorbDown {
    0% {
      transform: translate3d(0, 0, 0) scale(1, 1);
      opacity: 1;
      filter: blur(0px);
    }

    25% {
      transform: translate3d(0, 40px, 0) scale(0.98, 0.96);
      opacity: 0.98;
    }

    55% {
      transform: translate3d(0, 110px, 0) scale(0.92, 0.85);
      opacity: 0.9;
      filter: blur(0.6px);
    }

    80% {
      transform: translate3d(0, 190px, 0) scale(0.82, 0.65);
      opacity: 0.7;
      filter: blur(1.5px);
    }

    100% {
      transform: translate3d(0, 250px, 0) scale(0.6, 0.4);
      opacity: 0;
      filter: blur(3.5px);
    }
  }

  @keyframes funnelPulse {
    0% {
      transform: scale(1);
    }
    35% {
      transform: scale(1.018);
    }
    100% {
      transform: scale(1);
    }
  }
`}</style>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "radial-gradient(circle at top, #141d17 0%, #0a0e0c 38%, #050605 100%)",
  fontFamily: "Arial, sans-serif",
  padding: "18px 16px 20px",
  boxSizing: "border-box",
};

const paywallShellStyle: React.CSSProperties = {
  minHeight: "calc(100vh - 36px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  maxWidth: 520,
  margin: "0 auto",
};

const paywallCardStyle: React.CSSProperties = {
  width: "100%",
  background: "linear-gradient(180deg, #101613 0%, #0d1210 100%)",
  border: `1px solid ${border}`,
  borderRadius: 30,
  padding: 24,
  boxShadow: "0 18px 40px rgba(0,0,0,0.28)",
  textAlign: "center",
};

const paywallBadgeStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "7px 12px",
  borderRadius: 999,
  background: "rgba(183,255,49,0.12)",
  color: neonSoft,
  fontSize: 11,
  fontWeight: 900,
  letterSpacing: 1.1,
  marginBottom: 16,
};

const paywallTitleStyle: React.CSSProperties = {
  margin: "0 0 10px",
  color: text,
  fontSize: 30,
  fontWeight: 900,
  lineHeight: 1.05,
};

const paywallTextStyle: React.CSSProperties = {
  margin: "0 0 18px",
  color: muted,
  fontSize: 15,
  lineHeight: 1.5,
};

const paywallPlanBoxStyle: React.CSSProperties = {
  background: "linear-gradient(180deg, #1e2d21 0%, #172119 100%)",
  border: "1px solid #2c4b31",
  borderRadius: 24,
  padding: 18,
  marginBottom: 16,
  boxShadow: "0 14px 0 #0c120d, 0 24px 34px rgba(0,0,0,0.28)",
};

const paywallPlanLabelStyle: React.CSSProperties = {
  color: neonSoft,
  fontSize: 12,
  fontWeight: 900,
  letterSpacing: 1,
  marginBottom: 8,
};

const paywallPlanNameStyle: React.CSSProperties = {
  color: text,
  fontSize: 24,
  fontWeight: 900,
  lineHeight: 1.2,
  marginBottom: 8,
};

const paywallPlanPriceStyle: React.CSSProperties = {
  color: neon,
  fontSize: 26,
  fontWeight: 1000,
};

const paywallInputStyle: React.CSSProperties = {
  width: "100%",
  padding: "14px 14px",
  marginBottom: 12,
  borderRadius: 16,
  border: `1px solid ${border}`,
  outline: "none",
  boxSizing: "border-box",
  background: dark3,
  fontSize: 14,
  color: text,
};

const paywallMessageStyle: React.CSSProperties = {
  marginBottom: 14,
  color: "#ffd089",
  fontSize: 14,
  fontWeight: 800,
};

const paywallButtonsWrapStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const heroStyle: React.CSSProperties = {
  background: "linear-gradient(180deg, #101613 0%, #0d1210 100%)",
  border: `1px solid ${border}`,
  borderRadius: 30,
  padding: 20,
  boxShadow: "0 18px 40px rgba(0,0,0,0.28)",
  marginBottom: 16,
};

const sectionTitleStyle: React.CSSProperties = {
  color: text,
  fontSize: 20,
  fontWeight: 900,
  marginBottom: 12,
};

const funnelWrapStyle: React.CSSProperties = {
  position: "relative",
  width: "100%",
  maxWidth: 520,
  margin: "2vh auto 0",
  zIndex: 1,
};

const funnelNeckStyle: React.CSSProperties = {
  width: 0,
  height: 0,
  margin: "0 auto",
  borderLeft: "50px solid transparent",
  borderRight: "50px solid transparent",
  borderTop: `44px solid ${panelSoft}`,
  filter: "drop-shadow(0 10px 18px rgba(0,0,0,0.35))",
};

const mainFrameStyle: React.CSSProperties = {
  background: `linear-gradient(180deg, ${panelSoft} 0%, ${panel} 100%)`,
  border: `1px solid ${neon}`,
  borderRadius: 28,
  padding: 18,
  boxShadow: "0 26px 50px rgba(0,0,0,0.34), 0 0 0 1px rgba(183,255,49,0.08) inset",
};

const frameHeaderStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "7px 12px",
  borderRadius: 999,
  background: "rgba(183,255,49,0.12)",
  color: neonSoft,
  fontSize: 11,
  fontWeight: 900,
  letterSpacing: 1.1,
  marginBottom: 14,
};

const centerCardStyle: React.CSSProperties = {
  background: "linear-gradient(180deg, #1e2d21 0%, #172119 100%)",
  border: "1px solid #2c4b31",
  borderRadius: 24,
  padding: 20,
  textAlign: "center",
  minHeight: 230,
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  boxShadow: "0 14px 0 #0c120d, 0 24px 34px rgba(0,0,0,0.28)",
};

const currentSeriesNumberStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  alignSelf: "center",
  marginBottom: 12,
  padding: "8px 16px",
  borderRadius: 14,
  background: "rgba(183,255,49,0.14)",
  border: "1px solid rgba(183,255,49,0.22)",
  color: neonSoft,
  fontSize: 30,
  fontWeight: 1000,
  letterSpacing: 0.6,
  boxShadow: "none",
};

const uniformGreenCardStyle: React.CSSProperties = {
  background: "linear-gradient(180deg, #a4ff22 0%, #79db19 100%)",
  color: "#000000",
  borderRadius: 24,
  padding: 18,
  marginBottom: 12,
  height: 200,
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  boxSizing: "border-box",
  boxShadow: "0 12px 0 #33580f, 0 22px 26px rgba(0,0,0,0.22)",
  transition: "transform 0.22s ease-out, opacity 0.22s ease-out, filter 0.22s ease-out",
  willChange: "transform, opacity",
  transform: "translateZ(0)",
  backfaceVisibility: "hidden",
  overflow: "hidden",
};

const uniformDoneCardStyle: React.CSSProperties = {
  background: "linear-gradient(180deg, #313735 0%, #252a28 100%)",
  border: "1px solid #3b4440",
  borderRadius: 24,
  padding: 18,
  marginBottom: 12,
  height: 200,
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  boxSizing: "border-box",
  boxShadow: "0 10px 0 #191d1b, 0 18px 22px rgba(0,0,0,0.2)",
  transition: "transform 0.5s ease, opacity 0.5s ease",
  overflow: "hidden",
};

const routineQueueOrangeCardStyle: React.CSSProperties = {
  background: "linear-gradient(180deg, #ffb347 0%, #ff8c1a 100%)",
  borderRadius: 24,
  padding: 18,
  marginBottom: 12,
  boxSizing: "border-box",
  boxShadow: "0 12px 0 #a55407, 0 22px 26px rgba(0,0,0,0.22)",
};

const routineMiniStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "6px 10px",
  borderRadius: 12,
  background: "rgba(183,255,49,0.12)",
  color: neonSoft,
  fontWeight: 900,
  fontSize: 11,
  letterSpacing: 0.6,
  marginBottom: 12,
};

const routineMiniOrangeStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "6px 10px",
  borderRadius: 12,
  background: "rgba(0,0,0,0.14)",
  color: "#000000",
  fontWeight: 900,
  fontSize: 12,
  letterSpacing: 0.6,
  marginBottom: 12,
  alignSelf: "flex-start",
};

const routineMiniDoneStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "6px 10px",
  borderRadius: 12,
  background: "rgba(255,255,255,0.04)",
  color: "#9aa69f",
  fontWeight: 900,
  fontSize: 12,
  letterSpacing: 0.6,
  marginBottom: 12,
  alignSelf: "flex-start",
};

const restBoxStyle: React.CSSProperties = {
  background: "linear-gradient(180deg, #101613 0%, #0d120f 100%)",
  border: `1px solid ${border}`,
  borderRadius: 18,
  padding: 14,
};

const emptyStyle: React.CSSProperties = {
  textAlign: "center",
  padding: "24px 18px",
  borderRadius: 22,
  background: "linear-gradient(180deg, #131916 0%, #101512 100%)",
  border: `1px dashed ${border}`,
  color: muted,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "14px 14px",
  marginBottom: 12,
  borderRadius: 16,
  border: `1px solid ${border}`,
  outline: "none",
  boxSizing: "border-box",
  background: dark3,
  fontSize: 14,
  color: text,
};

const numberFieldsGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr 1.55fr",
  gap: 10,
  alignItems: "start",
};

const numberFieldWrapStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
};

const numberInputStyle: React.CSSProperties = {
  width: "100%",
  padding: "14px 10px",
  borderRadius: 16,
  border: `1px solid ${border}`,
  outline: "none",
  boxSizing: "border-box",
  background: dark3,
  fontSize: 24,
  fontWeight: 900,
  color: text,
  textAlign: "center",
};

const numberFieldLabelStyle: React.CSSProperties = {
  marginTop: 8,
  color: muted,
  fontSize: 13,
  fontWeight: 800,
  textAlign: "center",
};

const primaryButtonStyle: React.CSSProperties = {
  background: "linear-gradient(180deg, #b7ff31 0%, #88ea16 100%)",
  color: "#0f190b",
  border: "none",
  padding: "13px 18px",
  borderRadius: 16,
  fontWeight: 900,
  cursor: "pointer",
  boxShadow: "0 8px 0 #3f7010, 0 18px 24px rgba(0,0,0,0.22)",
};

const secondaryButtonStyle: React.CSSProperties = {
  background: "linear-gradient(180deg, #1a211d 0%, #111612 100%)",
  color: text,
  border: `1px solid ${border}`,
  padding: "12px 14px",
  borderRadius: 16,
  fontWeight: 800,
  cursor: "pointer",
  boxShadow: "0 6px 0 #090c0a",
};

const modalOverlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.56)",
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  padding: 16,
  zIndex: 80,
};

const modalStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 380,
  background: "linear-gradient(180deg, #121815 0%, #0e1310 100%)",
  border: `1px solid ${border}`,
  borderRadius: 26,
  padding: 20,
  boxShadow: "0 30px 60px rgba(0,0,0,0.42)",
};