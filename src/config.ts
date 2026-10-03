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
  idealContactTLow: 0.04, // 下手球（擊球點低於網：放網、挑球）拍子揮得短，完美時機晚一點
  flickBuffer: 0.08, // 揮拍／硬直結束前這段時間內划的會被保留
  softTapLead: 0.32, // 點擊滑放「只點不滑」：羽球這麼久內會到身邊才出拍（否則當作連按兩下的第一下）
  whiffRecover: 0.15,
  highZoneY: 2.0, // 以上算「高點」（高遠/殺/切）

  // 移動
  moveSpeed: 6.4,
  moveAccel: 24, // 起步加速度（有慣性：從站定到全速約 0.27 秒）
  moveBrake: 40, // 煞車／轉向比起步快（跨步煞停），但還是要時間
  moveDirMul: { back: 0.86, side: 0.95 }, // 往後退（離網）、橫移的最高速倍率（往前衝 = 1）
  // 被調動：對手擊球後要跑多遠、時間夠不夠。餘裕 = 經過時間 − 反應 − 最快跑到擊球點的時間；
  // 餘裕 < easy 開始扣球質，少 span 秒扣到最多 penalty（大對角、到位的切球讓對手來不及站穩）
  pressure: { reaction: 0.18, comfy: 0.7, easy: 0.25, span: 0.35, penalty: 0.3, backhandRear: 0.15 },
  // 接快球：擊球當下來球（換算成球速倍率後）比 from m/s 快越多越難回好球，span 後到最大；
  // 依回球種類扣：side = 反抽、up = 挑、down = 擋網；完美時機的寬度也跟著變窄 window
  heat: { from: 10.5, span: 6, side: 0.45, up: 0.25, down: 0.2, window: 0.35 },
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
  assistReachMul: 1.1, // 輔助跑位的擊球範圍倍率
  // 自動跑位的預判起步：平常對手擊球後 baseReaction 秒才起步；在對手擊球前 preWindow 秒到擊球後 window 秒內
  // 用左手往球的方向按住拖 → 立刻起步；猜錯 → 多等 wrongPenalty 秒
  anticipation: { baseReaction: 0.24, preWindow: 0.4, window: 0.25, wrongPenalty: 0.15 },
  // 網前撲球：網前 zone 公尺內、球高於網時按平球（點一下／左右滑）就變撲球
  netKill: { zone: 2.3, depth: 3.4, maxSpeed: 21, speedMul: 1.35 }, // 比一般撲球快 1.35 倍（約 75 km/h）、初速上限 21 m/s；打向中場，反應得過來還救得到
  // 抓球：中前場（網前撲球區外到離網 zone 公尺）、球高於網子附近時「點一下」（平球）→ 搶下來往下壓
  intercept: { zone: 3.8, depth: 4.2, speedMul: 1.15, minY: -0.1 },
  // 被殺近身（球路離身體 lateral m 內）時平抽只能擋網前（blockDepth m）
  bodySmash: { lateral: 0.45, blockDepth: 1.6 },
  attackSmashBonus: 0.1, // 殺「不到位的高球」最多快這麼多（高遠球越短越好殺，機會球最多）
  // 硬伸手接快球的懲罰：品質 × (1 - penalty × 來球兇度 × 遠)；兇度：殺球 1、撲壓 0.8、平抽 0.5；遠 = 離身體 comfy m → 擊球範圍邊緣
  stretch: { comfy: 0.6, penalty: 0.75, maxFail: 0.8 },

  // 線上：收到對方擊球後要補多少網路延遲（0 = 不補，接球方拿到完整反應時間）；
  // dilate：自己打過去的球在本機整段平均放慢（抵掉來回延遲），對方回球時球就在他的球拍附近、不會瞬移
  // （holdScale／holdMax：另一種做法「到對方球拍附近才放慢」，實測比較差，預設關掉）
  online: { fastForward: 0, dilate: true, holdScale: 1, holdMax: 0, holdMargin: 0 },
  // 4 人線上：打向自己這隊的球，在「別支手機上的隊友」球拍附近（自己這支手機上的人都搆不到、這球分給他接）時本機放慢
  // （scale 倍速，放慢到剛好抵掉他的擊球傳過來的時間，最多 max 模擬秒），隊友的擊球訊息到的時候球還在他附近，不會落地又彈回來
  quadHold: { scale: 0.3, max: 0.5, margin: 0.4 },

  serveContactY: 0.95,
  pointPause: 1.8,

  // 得分回放（主動得分才播，src/render/replay.ts）：得分後 delay 模擬秒開始（比賽在回放期間暫停，播完才繼續），
  // 從致勝那一拍前 pre 模擬秒播到落地後 post 模擬秒；擊球瞬間 slow 倍（相對正常遊戲速度）慢動作，
  // 羽球飛行的速度自動調整讓整段約 target 秒（真實時間），飛行倍率限制在 flightMin～flightMax
  replay: { delay: 0.5, pre: 0.42, post: 0.2, slow: 0.26, target: 3.0, flightMin: 0.5, flightMax: 2.4 },
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

/** 難度：簡單／普通／困難／超難／地獄 */
export type Difficulty = 'easy' | 'normal' | 'hard' | 'extreme' | 'hell';

export type MoveMode = 'auto' | 'assist' | 'manual';

/** 背景音樂：auto = 依場地自動（每個場地自己的撥弦曲風）；其他 = 固定一首（src/audio.ts 的 MUSIC_TRACKS） */
export type MusicTrack = 'auto' | 'sakura' | 'sports' | 'synth' | 'lofi' | 'bossa';

export interface MatchSettings {
  difficulty: Difficulty;
  points: 11 | 15 | 21;
  games: 1 | 3;
  landingHint: boolean;
  vibration: boolean;
  sound: boolean; // 音效＋環境音
  music: boolean; // 背景音樂
  musicTrack: MusicTrack; // 背景音樂選曲
  umpire: boolean; // 裁判報分語音
  replay: boolean; // 得分回放：主動得分時播約 3 秒的慢動作特寫（線上、教學、訓練不播）
  character: string; // 自己的球員
  racket: string; // 自己的球拍
  /** 跑位：auto = 自動（可以預判起步）、assist = 輔助（自己推、電腦幫忙對準＋自動回位）、manual = 手動 */
  moveMode: MoveMode;
  autoMove: boolean; // 簡單模式：自動跑位，只控制擊球
  autoDive: boolean; // 自動跑位時由電腦自動魚躍（否則左邊划動自己撲）
  scheme: ControlScheme; // 擊球操作方式
  venue: Venue; // 場地（訓練、教學、線上房主、選單背景用；比賽設定選「隨機」時不變）
  // ---- 比賽設定畫面（開始比賽前選，記住上次的選擇）----
  matchType: 'singles' | 'doubles' | 'quad'; // 單打／雙打（實際比賽用 doubles 欄位）；quad = 線上雙打 4 人房（只有建立線上房間能選）
  allManual?: boolean; // 線上 4 人房：全員手動跑位（房主選）
  roomPublic?: boolean; // 建立線上房間：公開到遊戲大廳（預設開；關掉 = 只能用房號進）
  venuePick: Venue | 'random'; // 比賽場地（隨機 = 每場隨機）
  myColor: string; // 自己的球衣色：'auto' = 球員原色，其他 = ui/colors.ts 色盤 id
  oppColor: string; // 對手（隊）球衣色：'random' = 隨機，其他 = 色盤 id
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
  musicTrack: 'auto',
  umpire: true,
  replay: true,
  character: 'allround',
  racket: 'balance',
  moveMode: 'auto',
  autoMove: true,
  autoDive: false,
  scheme: 'tap',
  venue: 'sakura',
  matchType: 'singles',
  allManual: false,
  roomPublic: true,
  venuePick: 'sakura',
  myColor: 'auto',
  oppColor: 'random',
};

/**
 * 鏡頭：y = 高度、z = 離球場中心的距離、lookZ = 看向的位置。
 * y/z 越小越平（越接近水平視角）。視角大小會自動算到剛好塞滿球場。
 */
export const CAMERA = {
  portrait: { y: 10.8, z: 13.2, lookZ: -0.4, follow: 0.08 },
  landscape: { y: 8.2, z: 14.6, lookZ: 0.2, follow: 0.22 },
};
