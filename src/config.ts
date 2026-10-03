// 所有長度單位為公尺、時間為「模擬秒」。手感調整集中在這個檔案。

export const COURT = {
  halfLength: 6.7, // 底線到網
  singlesHalfWidth: 2.59, // 單打邊線
  doublesHalfWidth: 3.05, // 雙打邊線（只畫線）
  shortService: 1.98, // 前發球線到網
  doublesLongService: 5.94, // 雙打後發球線到網（只畫線）
  netTop: 1.524,
  postTop: 1.55,
};

export const PHYS = {
  g: 9.81,
  // 真實羽球終端速度約 6.7 m/s；稍微調大讓球飛得遠一點、手感較好
  terminalVel: 8.0,
  dt: 1 / 120,
};
export const DRAG_K = PHYS.g / (PHYS.terminalVel * PHYS.terminalVel);

export const GAME = {
  // 模擬時間 = 真實時間 × simSpeed（真實羽球太快，放慢才能反應）
  simSpeed: 0.62,

  // 蓄力：從 0 到滿所需的模擬秒數。蓄力值 c ∈ [0,1] 線性對應「落點越過網子的深度」
  chargeDelay: 0, // 按下後先等這段時間才開始累積蓄力（試過 0.12，玩起來不喜歡）
  chargeTime: 0.65, // 開始累積後，從 0 到滿所需時間
  depthAtZero: -0.6, // 蓄力 0 → 落在網前 0.6 m（掛網）
  depthAtFull: 7.6, // 蓄力滿 → 超過底線 0.9 m（出界）。好球區約佔蓄力條 75%

  // 球速：殺球／撲球／下壓維持原速，其他球的飛行時間縮短為 1/ballSpeedMul
  ballSpeedMul: 1.5,
  killMaxSpeed: 16, // 網前撲球初速上限（m/s），避免近網撲殺快到無法反應
  smashMaxSpeed: 54, // 殺球／平抽初速上限（m/s，約 195 km/h）
  liftMaxSpeed: 45, // 高遠／挑球初速上限（m/s，約 160 km/h）

  // 擊球判定
  reach: 1.15, // 水平可及距離
  reachMinY: 0.05,
  reachMaxY: 2.85,
  swingWindow: 0.2, // 划動後這段時間內羽球進入範圍就會擊中
  swingDuration: 0.32,
  idealContactT: 0.07, // 划動後這麼久擊中最完美（拍子需要時間揮過來）
  flickBuffer: 0.08, // 揮拍／硬直結束前這段時間內划的會被保留
  softTapLead: 0.32, // 點擊滑放「只點不滑」：羽球這麼久內會到身邊才出拍（否則當作連按兩下的第一下）
  whiffRecover: 0.15,
  highZoneY: 2.0, // 以上算「高點」（高遠/殺/切）

  // 移動
  moveSpeed: 6.4,
  moveAccel: 42,
  chargeMoveMul: 0.65,
  swingMoveMul: 0.5,

  // 跳殺：右手連按兩下並按住 → 羽球快到時自動起跳
  jump: {
    height: 0.5, // 起跳高度（m），擊球範圍跟著往上加
    gravity: 12, // 跳躍用的重力（調小 = 滯空久一點，比較好抓擊球時機）
    lead: 0.0, // 起跳時機微調（秒）：正值 = 更早跳，負值 = 更晚跳
    minShuttleY: 2.3, // 羽球至少這麼高才會自動起跳（平抽、低挑不會誤跳）
    landRecover: 0.2, // 落地硬直（秒）
    landMoveMul: 0.3,
    smashBallMul: 1.15, // 跳殺球速倍率
    smashMaxSpeed: 62, // 跳殺初速上限（m/s，約 225 km/h）
  },

  // 魚躍（撲救）：移動搖桿連按兩下再往某方向划（自動跑位：左邊撲救區直接划）；撲到就自動救回網前
  dive: {
    dur: 0.36, // 撲出去到身體著地（秒）
    dist: 1.7, // 從靜止撲出的距離（m）
    reachBonus: 0.5, // 身體撲平、手臂和拍子伸直：擊球範圍往撲的方向多出這麼多
    maxY: 1.5, // 撲出去時打得到的最高點
    down: 0.56, // 趴在地上到爬起來（秒），不能動也不能揮拍
    quality: 0.66, // 自動救球的品質
    depth: 1.3, // 自動救回網前（放網）的深度
  },
  manualReachMul: 1.2, // 手動跑位時玩家的擊球範圍倍率（自動跑位與 AI = 1）
  // 網前撲球：網前 zone 公尺內、球高於網時按平球（點一下／左右滑）就變撲球
  netKill: { zone: 2.3, depth: 3.4, maxSpeed: 21, speedMul: 1.35 }, // 比一般撲球快 1.35 倍（約 75 km/h）、初速上限 21 m/s；打向中場，反應得過來還救得到
  attackSmashBonus: 0.1, // 殺「不到位的高球」最多快這麼多（高遠球越短越好殺，機會球最多）
  // 硬伸手接快球的懲罰：品質 × (1 - penalty × 來球兇度 × 遠)；兇度：殺球 1、撲壓 0.8、平抽 0.5；遠 = 離身體 comfy m → 擊球範圍邊緣
  stretch: { comfy: 0.6, penalty: 0.75, maxFail: 0.8 },

  serveContactY: 0.95,
  pointPause: 1.8,
};

/**
 * 蓄力曲線：前段上升快（小力很快就有）、後段慢（深球比較好控制）。
 * c = 1 - (1 - u)^1.8，u = (按住時間 - chargeDelay) / chargeTime
 */
const CHARGE_EXP = 1.8;
export function chargeFromTime(t: number): number {
  const u = Math.min(1, Math.max(0, (t - GAME.chargeDelay) / GAME.chargeTime));
  return 1 - Math.pow(1 - u, CHARGE_EXP);
}
export function timeForCharge(c: number): number {
  return GAME.chargeDelay + GAME.chargeTime * (1 - Math.pow(1 - Math.min(1, Math.max(0, c)), 1 / CHARGE_EXP));
}

/** charge = 按住蓄力＋划動；tap = 點一下下手／點兩下上手＋滑動、放開出拍，殺球鍵 */
export type ControlScheme = 'charge' | 'tap';

export type Venue = 'indoor' | 'bamboo' | 'sakura' | 'night' | 'market' | 'paddy' | 'beach';

export type Difficulty = 'easy' | 'normal' | 'hard';

export interface MatchSettings {
  difficulty: Difficulty;
  points: 11 | 15 | 21;
  games: 1 | 3;
  landingHint: boolean;
  vibration: boolean;
  sound: boolean; // 音效＋環境音
  music: boolean; // 背景音樂
  umpire: boolean; // 裁判報分語音
  character: string; // 自己的球員
  racket: string; // 自己的球拍
  autoMove: boolean; // 簡單模式：自動跑位，只控制擊球
  autoDive: boolean; // 自動跑位時由電腦自動魚躍（否則左邊划動自己撲）
  scheme: ControlScheme; // 擊球操作方式
  venue: Venue; // 場地
  aiCharacter?: string; // 對手（每場隨機）
  aiRacket?: string;
  practice?: boolean; // 練習模式：發球機餵球、不計分
  doubles?: boolean; // 雙打：0 號（自己）＋2 號（夥伴）在近側，1、3 號在遠側
  partnerCharacter?: string; // 雙打：2 號（夥伴）
  partnerRacket?: string;
  ai2Character?: string; // 雙打：3 號（第二位對手）
  ai2Racket?: string;
  settingsVersion?: number; // 存檔格式版本（改預設值時用來遷移舊存檔）
}

export const DEFAULT_SETTINGS: MatchSettings = {
  difficulty: 'normal',
  points: 11,
  games: 1,
  landingHint: true,
  vibration: true,
  sound: true,
  music: true,
  umpire: true,
  character: 'allround',
  racket: 'balance',
  autoMove: true,
  autoDive: false,
  scheme: 'tap',
  venue: 'sakura',
};

/**
 * 鏡頭：y = 高度、z = 離球場中心的距離、lookZ = 看向的位置。
 * y/z 越小越平（越接近水平視角）。視角大小會自動算到剛好塞滿球場。
 */
export const CAMERA = {
  portrait: { y: 10.8, z: 13.2, lookZ: -0.4, follow: 0.08 },
  landscape: { y: 8.2, z: 14.6, lookZ: 0.2, follow: 0.22 },
};
