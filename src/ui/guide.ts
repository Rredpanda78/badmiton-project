// 球種說明：每種球怎麼打（依目前的操作方式）、什麼時候用。從「設定」打開。
import type { ControlScheme } from '../config';

interface ShotGuide {
  name: string;
  tap: string; // 點擊滑放的手勢
  charge: string; // 蓄力划動的手勢
  when: string; // 什麼時候用、打出來是什麼球
}

const SHOTS: ShotGuide[] = [
  {
    name: '高遠球',
    tap: '後場高球：按住 → <b>往上滑</b>放開（自動用上手）',
    charge: '後場高球：蓄力到深綠色 → <b>往上划</b>',
    when: '把球打到對方底線，爭取時間回位。時機越準越貼底線；打太短對手會殺得更兇。',
  },
  {
    name: '挑球',
    tap: '網前低球：按住 → <b>往上滑</b>放開（自動用下手）',
    charge: '網前低球：蓄力到綠色 → <b>往上划</b>',
    when: '被壓在網前時把球挑到對方後場解圍。',
  },
  {
    name: '切球',
    tap: '後場高球：按住 → <b>往下滑</b>放開；或「殺」搖桿<b>往上滑</b>（假殺真切）',
    charge: '後場高球：<b>只蓄一點點</b>（剛進綠色）→ <b>往下划</b>',
    when: '讓球輕輕落到對方網前，逼對手上網。時機越準越貼網。',
  },
  {
    name: '放小球（放網）',
    tap: '網前低球：按住 → <b>往下滑</b>放開',
    charge: '網前低球：輕輕蓄一下 → <b>往下划</b>',
    when: '貼著網過去、落在對方網前。時機越準越貼網、越低，對手越難搶。',
  },
  {
    name: '殺球',
    tap: '右上「殺」搖桿：<b>往下滑</b>放開，左右滑可以瞄準；只點 = 直線殺（電腦：右鍵）',
    charge: '高球：蓄力到綠色中後段 → <b>往下划</b>',
    when: '後場高球最主要的得分球。對方高遠球打不到位（偏短）時殺得更快（機會殺球）。',
  },
  {
    name: '跳殺',
    tap: '「殺」搖桿<b>點一下再按住</b> → 球快到時自動起跳 → 在空中滑放開',
    charge: '右手<b>點一下再按住</b>（連按兩下）→ 自動起跳 → 在空中往下划',
    when: '比殺球更快、更陡。起跳後要在最高點附近出拍。',
  },
  {
    name: '平抽',
    tap: '<b>左右滑</b>放開',
    charge: '蓄力 → <b>往左或往右划</b>',
    when: '球平平飛到身前時快速平抽回去，斜著滑可以控制方向。',
  },
  {
    name: '平球',
    tap: '球到身邊時<b>只點一下</b>（不滑）',
    charge: '—（蓄力划動沒有平球鍵，用左右划）',
    when: '最簡單的回球。網前、中前場遇到高於網子的球會自動變成撲球或抓球。',
  },
  {
    name: '撲球',
    tap: '網前（離網 2.3 m 內）球<b>比網高</b>時：只點一下或左右滑',
    charge: '網前球比網高時：往左或往右划',
    when: '對手小球放太高時直接往下撲，約 75 km/h，打向對方中場。',
  },
  {
    name: '抓球',
    tap: '中前場（離網 2.3～3.8 m）平飛過來、<b>到網子高度以上</b>的球：只點一下',
    charge: '—（用左右划打平抽）',
    when: '雙打前場搶攔截：隊友殺球後對手回平球，前面的人搶下來往下壓。',
  },
  {
    name: '魚躍撲救',
    tap: '自動跑位：左邊橘色「撲」圈往球的方向划；手動跑位：移動搖桿<b>連按兩下</b>再划',
    charge: '同左',
    when: '殺球打到身體遠處跑不到時用。撲到一定救回網前；硬伸手去接遠的殺球常會掛網或變機會球。撲完要趴一下才爬得起來。',
  },
  {
    name: '發球',
    tap: '站在發球區：按住 → <b>往上滑</b>放開 = 發高遠球、<b>往下滑</b>放開 = 發小球',
    charge: '站在發球區：蓄力 → <b>往上划</b> = 發高遠球、<b>往下划</b> = 發小球',
    when: '雙打多發小球（後發球線比較短）；單打高遠球、小球交替用。',
  },
];

const TIMING = '<b>時機</b>：球打過來時腳邊的白圈變<b>綠色</b>就是出拍的好時機。完美的球最到位（高遠更深、小球更貼網、殺球更快），勉強接到的球會變成又高又慢的機會球。';

let overlay: HTMLElement | null = null;

/** 打開球種說明（依操作方式顯示手勢） */
export function openGuide(scheme: ControlScheme, onClose?: () => void): void {
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'guide';
    overlay.className = 'overlay';
    document.body.appendChild(overlay);
  }
  const rows = SHOTS.map(
    (s) => `<div class="guide-shot"><h4>${s.name}</h4><p class="how">${scheme === 'tap' ? s.tap : s.charge}</p><p class="when">${s.when}</p></div>`,
  ).join('');
  overlay.innerHTML = `<div class="panel"><h2>球種說明</h2><p class="tag">目前的操作方式：${scheme === 'tap' ? '點擊滑放' : '蓄力划動'}（在設定裡切換）</p><p class="guide-timing">${TIMING}</p>${rows}<button class="primary" id="guideClose">知道了</button></div>`;
  overlay.classList.add('show');
  overlay.querySelector('#guideClose')!.addEventListener('click', () => {
    overlay!.classList.remove('show');
    onClose?.();
  });
}
