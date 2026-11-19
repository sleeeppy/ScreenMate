import assert from "node:assert/strict";
import { test } from "node:test";
import { Behavior, rotateCss, type Actor, type Arena } from "./behavior.ts";
import type { Ledge } from "./platforms.ts";

const arena: Arena = { ground: 1000, left: 0, right: 2000, top: 0 };

function makeActor() {
  const played: string[] = [];
  let finish: (() => void) | undefined;
  const actor: Actor = {
    heightPx: 260,
    walkSpeedPx: 100,
    play(motion, onFinished) {
      played.push(motion);
      finish = onFinished;
    },
  };
  return { actor, played, finishMotion: () => finish?.() };
}

/** 고정 난수: 순서대로 돌려준다 */
const sequence = (...values: number[]) => {
  let index = 0;
  return () => values[index++ % values.length];
};

function run(behavior: Behavior, seconds: number, step = 1 / 60): void {
  for (let t = 0; t < seconds; t += step) behavior.update(step, arena);
}

test("CSS 회전: 아래쪽 점을 반시계로 돌리면 오른쪽으로 간다", () => {
  const rotated = rotateCss({ x: 0, y: 100 }, Math.PI / 2);
  assert.ok(Math.abs(rotated.x - 100) < 1e-9 && Math.abs(rotated.y) < 1e-9);
});

test("잡아서 오른쪽으로 던지면 포물선으로 날아가 오른쪽에 착지한다", () => {
  const { actor, played } = makeActor();
  const behavior = new Behavior(actor, sequence(0.9));
  behavior.place(500, arena);
  behavior.grab({ x: 500, y: 800 }, 0);
  for (let i = 1; i <= 6; i++) {
    behavior.drag({ x: 500 + i * 20, y: 800 - i * 10 }, i * 16);
    behavior.update(1 / 60, arena);
  }
  behavior.release(6 * 16 + 5, arena);
  assert.equal(behavior.state, "fall");
  let peak = behavior.feet.y;
  for (let i = 0; i < 600 && behavior.state === "fall"; i++) {
    behavior.update(1 / 60, arena);
    peak = Math.min(peak, behavior.feet.y);
  }
  assert.notEqual(behavior.state, "fall");
  assert.equal(behavior.feet.y, arena.ground);
  assert.ok(behavior.feet.x > 650, `x=${behavior.feet.x}`);
  // 위로 625px/s → 약 75px 솟는다 (잡은 순간 발 높이 940 기준)
  assert.ok(peak < 940 - 40, `위로 솟았다가 떨어진다 (peak=${peak})`);
  assert.deepEqual(played.slice(0, 2), ["hang", "fall"]);
});

test("세게 떨어지면 착지 모션, 끝나면 서 있기", () => {
  const { actor, played, finishMotion } = makeActor();
  const behavior = new Behavior(actor, sequence(0.9));
  behavior.place(500, arena);
  behavior.grab({ x: 500, y: 800 }, 0);
  behavior.drag({ x: 500, y: 100 }, 16); // 들어 올림 → 발이 y=300
  run(behavior, 0.3);
  behavior.release(1000, arena); // 멈춘 채 놓음 → 자유 낙하
  run(behavior, 2);
  assert.equal(behavior.state, "land");
  finishMotion();
  assert.equal(behavior.state, "idle");
  assert.equal(played.at(-1), "idle");
});

test("바닥 근처에서 살짝 놓으면 바로 서 있기", () => {
  const { actor } = makeActor();
  const behavior = new Behavior(actor, sequence(0.9));
  behavior.place(500, arena);
  behavior.grab({ x: 500, y: 900 }, 0);
  behavior.update(1 / 60, arena);
  behavior.release(500, arena);
  assert.equal(behavior.state, "idle");
});

test("오른쪽으로 끌면 발이 왼쪽으로 처진다 (진자)", () => {
  const { actor } = makeActor();
  const behavior = new Behavior(actor);
  behavior.place(500, arena);
  behavior.grab({ x: 500, y: 700 }, 0);
  for (let i = 1; i <= 20; i++) {
    behavior.drag({ x: 500 + i * 25, y: 700 }, i * 16);
    behavior.update(1 / 60, arena);
  }
  assert.ok(behavior.roll < -0.05, `roll=${behavior.roll}`);
  assert.ok(behavior.feet.x < 500 + 20 * 25, "발이 잡은 점보다 왼쪽");
});

test("서 있다가 걷기 시작하고, 화면 끝에서 돌아선다", () => {
  const { actor, played } = makeActor();
  // 첫 대기 길이(최소 3초), 방향(<0.5 오른쪽), 걷기 길이(최대), 끝에서 돌아서기(<0.6)
  const behavior = new Behavior(actor, sequence(0, 0.1, 1, 0.1));
  behavior.place(1900, arena);
  run(behavior, 3.2);
  assert.equal(behavior.state, "walk");
  assert.ok(played.includes("walk"));
  assert.ok(behavior.facing < -0.5, "오른쪽을 보고 걷는다");
  run(behavior, 2);
  assert.ok(behavior.facing > 0.5, `돌아서서 왼쪽을 본다 (facing=${behavior.facing})`);
  assert.ok(behavior.feet.x <= 2000 - 260 * 0.3);
});

test("클릭: 머리는 쓰다듬기, 몸은 찌르기", () => {
  const { actor, played, finishMotion } = makeActor();
  const behavior = new Behavior(actor, sequence(0.9));
  behavior.place(500, arena);
  behavior.click({ x: 500, y: 1000 - 260 - 10 });
  assert.equal(played.at(-1), "pat");
  finishMotion();
  behavior.click({ x: 500, y: 1000 - 120 });
  assert.equal(played.at(-1), "poke");
  assert.equal(behavior.state, "react");
});

// ---------------------------------------------------------------- 창 발판 (M5)

const ledge = (id: number, y: number, left: number, right: number, windowX = left): Ledge => ({
  id,
  y,
  left,
  right,
  windowX,
});

test("떨어지다 창 위쪽 테두리를 지나면 그 창 위에 선다", () => {
  const { actor } = makeActor();
  const behavior = new Behavior(actor, sequence(0.9));
  const withLedge: Arena = { ...arena, ledges: [ledge(7, 600, 300, 900)] };
  behavior.place(500, withLedge);
  behavior.grab({ x: 500, y: 800 }, 0); // 발은 잡은 점 아래 200
  behavior.drag({ x: 500, y: 100 }, 16); // 발이 y=300 (테두리 위)
  for (let i = 0; i < 30; i++) behavior.update(1 / 60, withLedge);
  behavior.release(1000, withLedge);
  for (let i = 0; i < 120; i++) behavior.update(1 / 60, withLedge);
  assert.ok(behavior.onLedge);
  assert.equal(behavior.feet.y, 600);
  assert.notEqual(behavior.state, "fall");
});

test("창 테두리 아래에서 놓으면 창을 통과해 바닥까지 떨어진다", () => {
  const { actor } = makeActor();
  const behavior = new Behavior(actor, sequence(0.9));
  const withLedge: Arena = { ...arena, ledges: [ledge(7, 600, 300, 900)] };
  behavior.place(500, withLedge);
  behavior.grab({ x: 500, y: 700 }, 0); // 발 y=1000 → 잡은 점 아래로 300
  behavior.drag({ x: 500, y: 600 }, 16); // 발이 y=900, 엉덩이(키 260의 0.62배 위)도 테두리보다 한참 아래
  for (let i = 0; i < 30; i++) behavior.update(1 / 60, withLedge);
  behavior.release(1000, withLedge);
  for (let i = 0; i < 120; i++) behavior.update(1 / 60, withLedge);
  assert.ok(!behavior.onLedge);
  assert.equal(behavior.feet.y, arena.ground);
});

test("엉덩이가 창 테두리 근처에 오게 놓으면 바로 걸터앉고, 그림은 놓은 자리에서 테두리로 미끄러지듯 옮겨 간다", () => {
  const { actor, played, finishMotion } = makeActor();
  const behavior = new Behavior(actor, sequence(0.9));
  const withLedge: Arena = { ...arena, ledges: [ledge(7, 600, 300, 900)] };
  behavior.place(500, withLedge);
  behavior.grab({ x: 500, y: 700 }, 0); // 발 y=1000 → 잡은 점 아래로 300
  behavior.drag({ x: 500, y: 420 }, 16); // 발 y≈720 → 엉덩이 ≈ 720 - 161 = 559 (테두리 600보다 41 위, 앉은 엉덩이보다 18 위)
  for (let i = 0; i < 30; i++) behavior.update(1 / 60, withLedge);
  behavior.release(1000, withLedge);
  assert.equal(behavior.state, "sit");
  assert.ok(behavior.onLedge);
  assert.equal(behavior.feet.y, 600);
  assert.equal(behavior.seat, "edge");
  assert.equal(played.at(-1), "sit_drop_edge");
  // 그림은 놓은 자리(발 y≈720)에서 시작해 테두리 높이로 올라간다 (그동안 모션이 엉덩이를 앉은 높이로 내린다)
  assert.ok(behavior.shownFeet.y > 700);
  for (let i = 0; i < 30; i++) behavior.update(1 / 60, withLedge);
  assert.equal(behavior.shownFeet.y, 600);
  finishMotion();
  assert.equal(played.at(-1), "sit_edge");
  assert.equal(behavior.state, "sit");
});

test("엉덩이가 테두리 근처여도 세게 던지면 걸터앉지 않고 날아간다", () => {
  const { actor } = makeActor();
  const behavior = new Behavior(actor, sequence(0.9));
  const withLedge: Arena = { ...arena, ledges: [ledge(7, 600, 300, 900)] };
  behavior.place(500, withLedge);
  behavior.grab({ x: 500, y: 700 }, 0);
  behavior.drag({ x: 500, y: 420 }, 16);
  for (let i = 0; i < 30; i++) behavior.update(1 / 60, withLedge);
  behavior.drag({ x: 560, y: 420 }, 520);
  behavior.drag({ x: 700, y: 420 }, 560); // 0.04초에 140px = 3500px/s 옆으로
  behavior.release(565, withLedge);
  assert.equal(behavior.state, "fall");
  assert.ok(!behavior.onLedge);
});

test("창 테두리 근처에서 놓으면 바로 그 창 위에 선다", () => {
  const { actor } = makeActor();
  const behavior = new Behavior(actor, sequence(0.9));
  const withLedge: Arena = { ...arena, ledges: [ledge(7, 600, 300, 900)] };
  behavior.place(500, withLedge);
  behavior.grab({ x: 500, y: 900 }, 0);
  behavior.drag({ x: 500, y: 495 }, 16); // 발 y≈595
  for (let i = 0; i < 60; i++) behavior.update(1 / 60, withLedge);
  behavior.release(2000, withLedge);
  assert.equal(behavior.state, "idle");
  assert.ok(behavior.onLedge);
  assert.equal(behavior.feet.y, 600);
});

/** 창 위(y=600, x 300~900)에 세운다 */
function standOnWindow(random = sequence(0.9)) {
  const made = makeActor();
  const behavior = new Behavior(made.actor, random);
  const start: Arena = { ...arena, ledges: [ledge(7, 600, 300, 900)] };
  behavior.place(500, start);
  behavior.grab({ x: 500, y: 900 }, 0);
  behavior.drag({ x: 500, y: 500 }, 16);
  for (let i = 0; i < 60; i++) behavior.update(1 / 60, start);
  behavior.release(2000, start);
  assert.ok(behavior.onLedge);
  return { ...made, behavior };
}

test("창이 움직이면 같이 움직인다", () => {
  const { behavior } = standOnWindow();
  const x = behavior.feet.x;
  const moved: Arena = { ...arena, ledges: [ledge(7, 550, 340, 940)] };
  run2(behavior, 0.4, moved); // 매끄럽게 따라가므로 잠깐 뒤에 맞춘다
  assert.ok(behavior.onLedge);
  assert.ok(Math.abs(behavior.feet.x - (x + 40)) < 0.5, `x=${behavior.feet.x}`);
  assert.ok(Math.abs(behavior.feet.y - 550) < 0.5, `y=${behavior.feet.y}`);
});

test("창이 사라지면 떨어져서 바닥에 선다", () => {
  const { behavior, played } = standOnWindow();
  behavior.update(1 / 60, { ...arena, ledges: [] });
  assert.equal(behavior.state, "fall");
  assert.equal(played.at(-1), "fall");
  run(behavior, 2);
  assert.ok(!behavior.onLedge);
  assert.equal(behavior.feet.y, arena.ground);
});

test("창이 앞 창에 가려 발밑 구간이 없어지면 떨어진다", () => {
  const { behavior } = standOnWindow();
  // 같은 창이지만 보이는 구간이 발에서 먼 오른쪽만 남음
  behavior.update(1 / 60, { ...arena, ledges: [ledge(7, 600, 750, 900, 300)] });
  assert.equal(behavior.state, "fall");
});

test("창을 세게 흔들면 떨어진다", () => {
  const { behavior } = standOnWindow();
  let x = 300;
  for (let i = 0; i < 20 && behavior.state !== "fall"; i++) {
    x += i % 2 === 0 ? 160 : -160; // 30Hz로 160px씩 좌우 = 4800px/s
    const shaken: Arena = { ...arena, ledges: [ledge(7, 600, x, x + 600)] };
    behavior.update(1 / 30, shaken);
  }
  assert.equal(behavior.state, "fall");
  // 떨어져 나온 창에는 다시 앉지 않고 바닥까지
  const still: Arena = { ...arena, ledges: [ledge(7, 600, x, x + 600)] };
  run2(behavior, 2, still);
  assert.ok(!behavior.onLedge);
  assert.equal(behavior.feet.y, arena.ground);
});

test("창 위를 걷다가 끝에서 돌아선다 (창 밖으로 걸어 나가지 않음)", () => {
  // 놓았을 때 대기 4초(0), 방향 오른쪽(0.1), 걷기 길이 최대(1), 끝에서 돌아서기(0.3: 헛디딤 0.2 이상, 0.6 미만)
  const { behavior } = standOnWindow(sequence(0.9, 0, 0.1, 1, 0.3));
  const onWindow: Arena = { ...arena, ledges: [ledge(7, 600, 300, 900)] };
  run2(behavior, 12, onWindow);
  assert.ok(behavior.onLedge, `state=${behavior.state}`);
  assert.ok(behavior.feet.x <= 900 - 260 * 0.12 + 1e-6, `x=${behavior.feet.x}`);
});

test("창 끝에서 헛디디면 떨어진다", () => {
  // 놓았을 때 대기 4초(0), 방향 오른쪽(0.1), 걷기 길이 최대(1), 헛디딤(0.05)
  const { behavior, played } = standOnWindow(sequence(0.9, 0, 0.1, 1, 0.05));
  const onWindow: Arena = { ...arena, ledges: [ledge(7, 600, 300, 900)] };
  run2(behavior, 12, onWindow);
  assert.ok(played.includes("fall"));
  assert.ok(!behavior.onLedge);
  assert.equal(behavior.feet.y, arena.ground);
  assert.ok(behavior.feet.x > 900);
});

function run2(behavior: Behavior, seconds: number, where: Arena, step = 1 / 60): void {
  for (let t = 0; t < seconds; t += step) behavior.update(step, where);
}

test("걷다 멈출 때는 두 발이 엇갈리는 순간까지 마저 걷는다 (최대 0.6초)", () => {
  const { actor, played } = makeActor();
  let passing = false;
  actor.canStopWalking = () => passing;
  // 대기 3초(0), 방향 오른쪽(0.1), 걷기 길이 최소 2초(0)
  const behavior = new Behavior(actor, sequence(0, 0.1, 0, 0.9));
  behavior.place(500, arena);
  run(behavior, 3.1);
  assert.equal(behavior.state, "walk");
  run(behavior, 2.1); // 걷기 시간은 끝났지만 아직 발이 엇갈리지 않음
  assert.equal(behavior.state, "walk");
  const x = behavior.feet.x;
  run(behavior, 0.1);
  assert.ok(behavior.feet.x > x, "기다리는 동안에도 걷는다");
  passing = true;
  behavior.update(1 / 60, arena);
  assert.equal(behavior.state, "idle");
  assert.equal(played.at(-1), "idle");

  // 엇갈리는 순간이 안 오면 0.6초 뒤에 그냥 멈춘다
  passing = false;
  const again = new Behavior(actor, sequence(0, 0.1, 0, 0.9));
  again.place(500, arena);
  run(again, 3.1 + 2.1);
  assert.equal(again.state, "walk");
  run(again, 0.65);
  assert.equal(again.state, "idle");
});

// ---------------------------------------------------------------- M6: 버둥거리기·두리번·앉기·졸기

test("오래 들고 있으면 버둥거리고, 놓으면 떨어진다", () => {
  const { actor, played } = makeActor();
  const behavior = new Behavior(actor, sequence(0.9));
  behavior.place(500, arena);
  behavior.grab({ x: 500, y: 700 }, 0);
  behavior.drag({ x: 500, y: 500 }, 16);
  run(behavior, 2.5);
  assert.equal(played.at(-1), "hang");
  run(behavior, 1);
  assert.equal(played.at(-1), "hang_struggle");
  behavior.release(10_000, arena);
  assert.equal(played.at(-1), "fall");
});

test("세게 흔들면 바로 버둥거린다", () => {
  const { actor, played } = makeActor();
  const behavior = new Behavior(actor, sequence(0.9));
  behavior.place(500, arena);
  behavior.grab({ x: 500, y: 700 }, 0);
  // 3Hz로 ±300px 흔들기 (손 속력 평균 약 3600px/s), 1초
  for (let i = 1; i <= 60; i++) {
    const t = i / 60;
    behavior.drag({ x: 500 + 300 * Math.sin(2 * Math.PI * 3 * t), y: 600 }, t * 1000);
    behavior.update(1 / 60, arena);
  }
  assert.ok(played.includes("hang_struggle"));
  // 천천히 끄는 건 버둥거리지 않는다 (0.5Hz ±150px, 2초)
  const slow = makeActor();
  const calm = new Behavior(slow.actor, sequence(0.9));
  calm.place(500, arena);
  calm.grab({ x: 500, y: 700 }, 0);
  for (let i = 1; i <= 120; i++) {
    const t = i / 60;
    calm.drag({ x: 500 + 150 * Math.sin(2 * Math.PI * 0.5 * t), y: 600 }, t * 1000);
    calm.update(1 / 60, arena);
  }
  assert.ok(!slow.played.includes("hang_struggle"));
});

test("variety: 서 있기가 끝나면 가끔 두리번거리거나 기지개를 켜고 다시 선다", () => {
  const { actor, played, finishMotion } = makeActor();
  // 첫 대기(0 → 3초), 고르기 0.95(기지개), 다음 대기 0, 고르기 0.82(두리번)
  const behavior = new Behavior(actor, sequence(0, 0.95, 0, 0.82), { variety: true });
  behavior.place(500, arena);
  run(behavior, 3.1);
  assert.equal(behavior.state, "act");
  assert.equal(played.at(-1), "idle_stretch");
  finishMotion();
  assert.equal(behavior.state, "idle");
  run(behavior, 4.1);
  assert.equal(played.at(-1), "idle_look");
});

test("variety: 창 위에서 쉬다가 걸터앉고, 앉은 채 창을 따라가다 시간이 지나면 선다", () => {
  const made = makeActor();
  // 놓을 때 대기(0 → 4초), 고르기 0.1(걸터앉기), 앉는 시간 0(8초)
  const behavior = new Behavior(made.actor, sequence(0.9, 0, 0.1, 0), { variety: true });
  const onWindow: Arena = { ...arena, ledges: [ledge(7, 600, 300, 900)] };
  behavior.place(500, onWindow);
  behavior.grab({ x: 500, y: 900 }, 0);
  behavior.drag({ x: 500, y: 500 }, 16);
  run2(behavior, 1, onWindow);
  behavior.release(2000, onWindow);
  run2(behavior, 4.1, onWindow);
  assert.equal(behavior.state, "sit");
  assert.equal(behavior.seat, "edge");
  // 먼저 앉을 방향으로 돌아선 다음 앉는 모션, 끝나면 걸터앉기 반복
  run2(behavior, 0.8, onWindow);
  assert.equal(made.played.at(-1), "sit_down_edge");
  assert.equal(behavior.activity(), "interact");
  made.finishMotion();
  assert.equal(made.played.at(-1), "sit_edge");
  assert.ok(behavior.headHeight < 260 * 0.5, "앉으면 머리가 낮다");
  const x = behavior.feet.x;
  run2(behavior, 0.4, { ...arena, ledges: [ledge(7, 600, 350, 950)] });
  assert.ok(Math.abs(behavior.feet.x - (x + 50)) < 0.5, "앉은 채 창을 따라간다");
  run2(behavior, 8.2, { ...arena, ledges: [ledge(7, 600, 350, 950)] });
  // 시간이 지나면 일어서는 모션, 끝나면 서 있기
  assert.equal(behavior.state, "rise");
  assert.equal(behavior.seat, "edge");
  assert.equal(made.played.at(-1), "stand_up_edge");
  made.finishMotion();
  assert.equal(behavior.state, "idle");
});

test("오래 입력이 없으면 앉아서 졸고, 입력이 오면 일어선다", () => {
  const { actor, played, finishMotion } = makeActor();
  const behavior = new Behavior(actor, sequence(0.99), { sleepAfter: 5 });
  behavior.place(500, arena);
  run(behavior, 5.2);
  assert.equal(behavior.state, "sleep");
  assert.equal(behavior.seat, "floor");
  run(behavior, 0.8); // 돌아선 다음 앉기
  assert.equal(played.at(-1), "sit_down_floor");
  finishMotion();
  assert.equal(played.at(-1), "sleep_floor");
  behavior.noteActivity();
  assert.equal(behavior.state, "rise");
  assert.equal(played.at(-1), "stand_up_floor");
  finishMotion();
  assert.equal(behavior.state, "idle");
  assert.equal(played.at(-1), "idle");
});

test("앉는 도중에 잡으면 매달리고, 놓아도 앉기 반복으로 넘어가지 않는다", () => {
  const { actor, played, finishMotion } = makeActor();
  const behavior = new Behavior(actor, sequence(0.99), { sleepAfter: 1 });
  behavior.place(500, arena);
  run(behavior, 2);
  assert.equal(played.at(-1), "sit_down_floor");
  behavior.grab({ x: 500, y: 900 }, 0);
  finishMotion(); // (드라이버는 새 모션을 재생하면 이전 콜백을 버리지만, 와도 무시해야 한다)
  assert.equal(behavior.state, "held");
  assert.equal(played.at(-1), "hang");
  assert.equal(behavior.activity(), "interact");
});

test("앉아 있을 때는 낮아진 머리를 쓰다듬는다", () => {
  const { actor, played, finishMotion } = makeActor();
  const behavior = new Behavior(actor, sequence(0.99), { sleepAfter: 1 });
  behavior.place(500, arena);
  run(behavior, 1.2);
  assert.equal(behavior.state, "sleep");
  run(behavior, 1); // 앉을 쪽으로 돌아서 앉기 시작
  assert.equal(played.at(-1), "sit_down_floor");
  finishMotion();
  assert.equal(played.at(-1), "sleep_floor");
  // 앉은 머리 높이(키 0.42배) 근처 → 쓰다듬기, 서 있을 때 기준(0.9배)이면 머리 위 허공이다.
  // 일어서지 않고 앉은 채 반응하고(졸던 눈도 뜬다), 끝나면 앉기 반복으로 돌아간다
  behavior.click({ x: 500, y: 1000 - 260 * 0.4 });
  assert.equal(played.at(-1), "sit_pat_floor");
  assert.equal(behavior.state, "sit");
  finishMotion();
  assert.equal(played.at(-1), "sit_floor");
  assert.equal(behavior.state, "sit");
  // 몸을 찌르면 일어선 다음 반응한다
  behavior.click({ x: 500, y: 1000 - 260 * 0.1 });
  assert.equal(played.at(-1), "stand_up_floor");
  finishMotion();
  assert.equal(played.at(-1), "poke");
});

test("걸터앉아 있을 때도 앉은 채 쓰다듬는다", () => {
  const { actor, played, finishMotion } = makeActor();
  const behavior = new Behavior(actor, sequence(0.9));
  const withLedge: Arena = { ...arena, ledges: [ledge(7, 600, 300, 900)] };
  behavior.place(500, withLedge);
  behavior.grab({ x: 500, y: 700 }, 0);
  behavior.drag({ x: 500, y: 420 }, 16);
  for (let i = 0; i < 30; i++) behavior.update(1 / 60, withLedge);
  behavior.release(1000, withLedge); // 엉덩이가 테두리 근처 → 바로 걸터앉기
  finishMotion();
  assert.equal(played.at(-1), "sit_edge");
  behavior.click({ x: 500, y: 600 - 260 * 0.4 });
  assert.equal(played.at(-1), "sit_pat_edge");
  assert.equal(behavior.state, "sit");
  assert.ok(behavior.onLedge);
  finishMotion();
  assert.equal(played.at(-1), "sit_edge");
});

test("창이 일정하게 움직이면 매 프레임 고르게 따라간다 (창 위치가 두 프레임에 한 번 바뀌어도)", () => {
  const { behavior } = standOnWindow();
  const start = behavior.feet.x;
  let windowX = 300;
  const steps: number[] = [];
  let last = behavior.feet.x;
  for (let frame = 0; frame < 120; frame++) {
    if (frame % 2 === 0) windowX += 250 / 30; // 250px/s, 30Hz로만 바뀜
    behavior.update(1 / 60, { ...arena, ledges: [ledge(7, 600, windowX, windowX + 600)] });
    if (frame >= 30) steps.push(behavior.feet.x - last);
    last = behavior.feet.x;
  }
  const mean = steps.reduce((sum, step) => sum + step, 0) / steps.length;
  const spread = Math.sqrt(steps.reduce((sum, step) => sum + (step - mean) ** 2, 0) / steps.length);
  close2(mean, 250 / 60, 0.3);
  assert.ok(spread < mean * 0.15, `프레임마다 이동량 ${mean.toFixed(2)} ± ${spread.toFixed(2)}`);
  // 창보다 크게 뒤처지지 않는다
  assert.ok(Math.abs(behavior.feet.x - start - (windowX - 300)) < 10, "뒤처짐 10px 이내");
});

function close2(actual: number, expected: number, epsilon: number): void {
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≈ ${expected}`);
}

/** 오른쪽으로 세게 던진다 (발 x=1800 근처, 오른쪽 위로) */
function throwRight(behavior: Behavior, field: Arena): void {
  behavior.place(1800, field);
  behavior.grab({ x: 1800, y: 800 }, 0);
  for (let i = 1; i <= 6; i++) {
    behavior.drag({ x: 1800 + i * 30, y: 800 - i * 10 }, i * 16);
    behavior.update(1 / 60, field);
  }
  behavior.release(6 * 16 + 5, field);
}

test("옆 모니터가 없는 쪽으로 던지면 화면 끝에서 튕긴다", () => {
  const behavior = new Behavior(makeActor().actor, sequence(0.9));
  throwRight(behavior, arena);
  let maxX = behavior.feet.x;
  for (let i = 0; i < 600 && behavior.state === "fall"; i++) {
    behavior.update(1 / 60, arena);
    maxX = Math.max(maxX, behavior.feet.x);
  }
  assert.ok(maxX <= arena.right, `x=${maxX}`);
});

test("옆 모니터가 있는 쪽으로 던지면 화면 끝을 넘어 날아간다", () => {
  const open: Arena = { ...arena, openRight: true };
  const behavior = new Behavior(makeActor().actor, sequence(0.9));
  throwRight(behavior, open);
  let maxX = behavior.feet.x;
  for (let i = 0; i < 120 && behavior.state === "fall"; i++) {
    behavior.update(1 / 60, open);
    maxX = Math.max(maxX, behavior.feet.x);
  }
  assert.ok(maxX > arena.right, `x=${maxX}`);
});

test("모니터를 옮기면 들고 있던 좌표가 같은 만큼 옮겨지고 계속 끌린다", () => {
  const behavior = new Behavior(makeActor().actor, sequence(0.9));
  behavior.place(500, arena);
  behavior.grab({ x: 500, y: 800 }, 0);
  behavior.drag({ x: 520, y: 790 }, 16);
  run(behavior, 0.5);
  const before = { ...behavior.feet };
  behavior.translate(-1920, 40);
  assert.deepEqual(behavior.feet, { x: before.x - 1920, y: before.y + 40 });
  // 새 좌표계에서 같은 곳을 계속 끌면 순간이동 없이 그 자리에 있다
  behavior.drag({ x: 520 - 1920, y: 830 }, 32);
  for (let i = 0; i < 30; i++) behavior.update(1 / 60, { ...arena, left: -4000 });
  assert.ok(Math.abs(behavior.feet.x - (before.x - 1920)) < 30, `x=${behavior.feet.x}`);
});

test("자율: 닿는 창이 있으면 그 아래로 걸어가 웅크렸다 뛰어올라 창 위에 선다", () => {
  const { actor, played, finishMotion } = makeActor();
  // 대기(0 → 3초), 고르기 0.6(뛰어오르기 구간), 창 고르기 0
  const behavior = new Behavior(actor, sequence(0, 0.6, 0), { variety: true });
  const withWindow: Arena = { ...arena, ledges: [ledge(3, 700, 900, 1300)] };
  behavior.place(400, withWindow);
  let sawJump = false;
  for (let t = 0; t < 20 && !(behavior.onLedge && behavior.state !== "fall"); t += 1 / 60) {
    behavior.update(1 / 60, withWindow);
    if (behavior.state === "jump") sawJump = true;
    if (behavior.state === "land") finishMotion();
  }
  assert.ok(sawJump, "웅크린다");
  assert.ok(played.includes("jump") && played.includes("jump_air"), played.join(","));
  assert.equal(behavior.onLedge, true);
  assert.equal(behavior.feet.y, 700);
  assert.ok(behavior.feet.x >= 900 && behavior.feet.x <= 1300, `x=${behavior.feet.x}`);
});

test("자율: 창 위에서 끝까지 걸어가 뛰어내려 바닥에 선다", () => {
  const made = makeActor();
  const behavior = new Behavior(made.actor, sequence(0.9, 0, 0.7, 0), { variety: true });
  const onWindow: Arena = { ...arena, ledges: [ledge(7, 600, 300, 900)] };
  behavior.place(500, onWindow);
  behavior.grab({ x: 500, y: 900 }, 0);
  behavior.drag({ x: 500, y: 500 }, 16);
  run2(behavior, 1, onWindow);
  behavior.release(2000, onWindow);
  assert.equal(behavior.onLedge, true);
  for (let t = 0; t < 20 && !(behavior.feet.y === arena.ground && !behavior.airborne); t += 1 / 60) {
    behavior.update(1 / 60, onWindow);
    if (behavior.state === "land") made.finishMotion();
  }
  assert.equal(behavior.onLedge, false);
  assert.equal(behavior.feet.y, arena.ground);
  assert.ok(made.played.includes("jump_air"), made.played.join(","));
  assert.ok(behavior.feet.x < 300 || behavior.feet.x > 900, `창 밖으로 뛰어내림 x=${behavior.feet.x}`);
});

test("자율: 화면 밖으로 나갔다가 크게 엿보고, 보통 크기로 걸어 들어온다", () => {
  const { actor, played, finishMotion } = makeActor();
  // 놓기 대기 0, 가까운 쪽 0, 두리번 안 함 0.9, 화면 밖 시간 0(6초), 돌아오기 0.5(옆에서 크게), 같은 쪽 0.9, 머무는 시간 0, …
  const behavior = new Behavior(actor, sequence(0, 0, 0.9, 0, 0.5, 0.9, 0, 0.9, 0.9), { variety: true });
  behavior.place(300, arena);
  (behavior as unknown as { leaveScreen(where: Arena): void }).leaveScreen(arena);
  assert.equal(behavior.state, "walk");
  const until = (state: string, seconds: number) => {
    for (let t = 0; t < seconds && behavior.state !== state; t += 1 / 60) behavior.update(1 / 60, arena);
  };
  until("away", 15);
  assert.equal(behavior.state, "away");
  assert.ok(behavior.feet.x < arena.left, "화면 왼쪽 밖");
  behavior.consumeTeleport();
  until("peek", 10);
  assert.equal(behavior.state, "peek");
  assert.equal(behavior.displayScale, 2.3);
  assert.equal(behavior.consumeTeleport(), true, "크기를 바꾸며 순간이동");
  assert.equal(played.at(-1), "peek_left");
  // 잡히지 않는다
  behavior.grab({ x: 10, y: 500 }, 0);
  assert.equal(behavior.state, "peek");
  run(behavior, 1);
  assert.ok(behavior.roll < -0.3, `화면 쪽으로 기운다 roll=${behavior.roll}`);
  until("away", 8);
  assert.equal(behavior.state, "away");
  // 화면 밖에서 잠깐 쉬고 보통 크기로 걸어 들어온다
  until("walk", 7);
  assert.equal(behavior.displayScale, 1);
  for (let t = 0; t < 15 && behavior.state === "walk"; t += 1 / 60) behavior.update(1 / 60, arena);
  if (behavior.state === "act") finishMotion();
  assert.equal(behavior.state, "idle");
  assert.ok(behavior.feet.x > arena.left && behavior.feet.x < arena.right, `x=${behavior.feet.x}`);
});

test("자율: 엿보다가 눌리면 얼른 숨는다", () => {
  const { actor } = makeActor();
  const behavior = new Behavior(actor, sequence(0, 0, 0, 0.5, 0, 0, 0.1, 0.9), { variety: true });
  behavior.place(300, arena);
  (behavior as unknown as { startPeek(kind: string, where: Arena): void }).startPeek("up", arena);
  run(behavior, 1.2);
  assert.equal(behavior.state, "peek");
  const shown = behavior.feet.y;
  assert.ok(shown < arena.ground + 260 * 2.3, "아래에서 올라왔다");
  behavior.click({ x: behavior.feet.x, y: shown - 500 });
  run(behavior, 1);
  assert.notEqual(behavior.state, "peek");
});

test("자율: 아래에서 엿본 뒤에는 끝까지 내려가 숨고, 쉬는 동안 화면 아래에 머리가 남지 않는다", () => {
  const { actor } = makeActor();
  const behavior = new Behavior(actor, sequence(0.5, 0, 0.1, 0.9), { variety: true });
  behavior.place(300, arena);
  (behavior as unknown as { startPeek(kind: string, where: Arena): void }).startPeek("up", arena);
  const hidden = behavior.feet.y;
  assert.ok(hidden - 260 * 2.3 * 1.4 > arena.ground, "머리카락이 솟은 모델도 처음엔 다 숨어 있다");
  let lowest = 0;
  for (let t = 0; t < 15 && behavior.state === "peek"; t += 1 / 60) {
    behavior.update(1 / 60, arena);
    lowest = Math.max(lowest, behavior.feet.y);
  }
  assert.equal(behavior.state, "away");
  assert.ok(lowest - 260 * 2.3 * 1.3 > arena.ground, `머리 위로 솟은 부분까지 화면 아래로 내려간다 y=${lowest}`);
  assert.equal(behavior.displayScale, 1, "보통 크기로 돌아온다");
  assert.ok(behavior.feet.x < arena.left || behavior.feet.x > arena.right, `옆 화면 밖에서 쉰다 x=${behavior.feet.x}`);
});

test("자율 모드 20분: 새 행동이 모두 나오고, 한 상태에 오래 갇히지 않으며, 화면 밖에서 늘 돌아온다", () => {
  // 모션은 1.2초 뒤에 끝난다고 친다 (반복 모션은 끝나지 않음)
  const loops = new Set(["idle", "walk", "fall", "hang", "jump_air", "sit_edge", "sit_floor", "sleep_edge", "sleep_floor", "peek_left", "peek_right", "peek_up"]);
  // 콜백 안에서 바꾸는 값은 객체에 담는다 (let이면 TS가 null로 좁혀 버린다)
  const timer: { pending: { left: number; done: () => void } | null } = { pending: null };
  const played: string[] = [];
  const actor: Actor = {
    heightPx: 260,
    walkSpeedPx: 100,
    play(motion, onFinished) {
      played.push(motion);
      timer.pending = !loops.has(motion) && onFinished ? { left: 1.2, done: onFinished } : null;
    },
  };
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const behavior = new Behavior(actor, random, { variety: true, sleepAfter: Number.POSITIVE_INFINITY });
  const field: Arena = { ...arena, bottom: arena.ground + 40, ledges: [ledge(5, 650, 800, 1300)] };
  behavior.place(400, field);
  const step = 1 / 30;
  let stay = 0;
  let longest = 0;
  let last = behavior.state;
  const seen = new Set<string>();
  for (let t = 0; t < 1200; t += step) {
    behavior.update(step, field);
    const pending = timer.pending;
    if (pending) {
      pending.left -= step;
      if (pending.left <= 0) {
        timer.pending = null;
        pending.done();
      }
    }
    seen.add(behavior.state);
    stay = behavior.state === last ? stay + step : 0;
    last = behavior.state;
    if (behavior.state !== "sit") longest = Math.max(longest, stay);
  }
  const counts = (name: string) => played.filter((motion) => motion === name).length;
  for (const motion of ["jump", "jump_air", "land", "idle_look", "idle_stretch", "sit_down_edge", "sit_down_floor"]) {
    assert.ok(counts(motion) > 0, `${motion} 안 나옴: ${[...new Set(played)].join(",")}`);
  }
  assert.ok(counts("peek_left") + counts("peek_right") > 0, "옆 엿보기");
  assert.ok(counts("peek_up") > 0, "아래 엿보기");
  assert.ok(seen.has("away"), "화면 밖에 나갔다");
  assert.ok(longest < 30, `한 상태에 ${longest.toFixed(1)}초 머묾`);
  assert.equal(behavior.displayScale === 1 || behavior.state === "peek" || behavior.state === "away", true);
});

test("자율: 돌아올 때 보통 크기로 끝에서 고개를 내밀어 둘러본 뒤 그쪽에서 걸어 들어온다", () => {
  const { actor, played } = makeActor();
  // 화면 밖 → 돌아오기 0.1(고개 내밀기), 반대쪽 0, 둘러보는 시간 0
  const behavior = new Behavior(actor, sequence(0.1, 0, 0), { variety: true });
  behavior.place(300, arena);
  (behavior as unknown as { goAway(side: string, seconds: number): void }).goAway("left", 0.1);
  run(behavior, 0.2);
  assert.equal(behavior.state, "peek");
  assert.equal(behavior.displayScale, 1, "보통 크기");
  assert.equal(played.at(-1), "peek_right", "나간 반대쪽 끝에서");
  assert.ok(behavior.feet.x > arena.right, "발은 화면 밖");
  run(behavior, 1.6);
  assert.ok(behavior.roll > 0.3, `화면 쪽으로 기울어 고개가 들어온다 roll=${behavior.roll}`);
  for (let t = 0; t < 8 && behavior.state === "peek"; t += 1 / 60) behavior.update(1 / 60, arena);
  assert.equal(behavior.state, "walk", "둘러본 뒤 바로 걸어 들어온다");
  assert.ok(behavior.feet.x > arena.right, "같은 쪽(오른쪽)에서");
  assert.equal(played.includes("wave"), false, "손은 흔들지 않는다");
});

test("화면 밖 목표에 닿고 발이 엇갈릴 때까지 기다리는 동안 화면 안으로 끌려오지 않는다", () => {
  const { actor } = makeActor();
  // 실제 앱처럼 몇 프레임 뒤에야 멈출 수 있다
  let frames = 0;
  actor.canStopWalking = () => ++frames % 20 === 0;
  const behavior = new Behavior(actor, () => 0.6, { variety: true });
  behavior.place(800, arena);
  (behavior as unknown as { leaveScreen(where: Arena): void }).leaveScreen(arena);
  let maxSeenAfterOut = -Infinity;
  let wentOut = false;
  for (let t = 0; t < 20 && behavior.state !== "away"; t += 1 / 60) {
    behavior.update(1 / 60, arena);
    if (behavior.feet.x < arena.left) wentOut = true;
    if (wentOut) maxSeenAfterOut = Math.max(maxSeenAfterOut, behavior.feet.x);
  }
  assert.equal(behavior.state, "away");
  assert.ok(wentOut, "화면 밖으로 나갔다");
  assert.ok(maxSeenAfterOut < arena.left, `나간 뒤 화면 안으로 돌아오지 않는다 (x 최대 ${maxSeenAfterOut.toFixed(0)})`);
  assert.ok(behavior.feet.x < arena.left - 200, `화면 밖에서 사라진다 x=${behavior.feet.x.toFixed(0)}`);
});

test("화면 밖(away) 상태에서는 클릭해도 반응으로 바뀌지 않는다", () => {
  const { actor } = makeActor();
  const behavior = new Behavior(actor, sequence(0.9), { variety: true });
  behavior.place(500, arena);
  (behavior as unknown as { goAway(side: string, seconds: number): void }).goAway("left", 5);
  assert.equal(behavior.state, "away");
  behavior.click({ x: behavior.feet.x, y: behavior.feet.y - 100 });
  assert.equal(behavior.state, "away");
});

test("공중·드래그 중 모니터 전환(fit)으로 경계에서 안쪽으로 순간이동하지 않는다", () => {
  const { actor } = makeActor();
  const behavior = new Behavior(actor, sequence(0.9));
  behavior.place(500, arena);
  behavior.grab({ x: 500, y: 800 }, 0);
  behavior.drag({ x: 5, y: 800 }, 16);
  run(behavior, 0.2);
  const beforeX = behavior.feet.x;
  behavior.fit(arena);
  assert.equal(behavior.feet.x, beforeX, "들고 있는 동안 fit이 안쪽으로 끌어당기지 않는다");
});

test("모니터 좌표 이동(translate)은 속도 벡터(ledgeEstimate)를 오염시키지 않는다", () => {
  const { actor } = makeActor();
  const behavior = new Behavior(actor, sequence(0.9));
  behavior.place(500, arena);
  behavior.translate(-1920, 40);
  const estimate = (behavior as unknown as { ledgeEstimate: { x: number; y: number } }).ledgeEstimate;
  assert.deepEqual(estimate, { x: 0, y: 0 });
});

