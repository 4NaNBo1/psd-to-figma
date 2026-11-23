// These faces use PostScript names that cannot be inferred from their display names.
// Keep each weight separate: some families ship both DemiBold and SemiBold.
const FONT_FAMILIES = [
  {
    family: 'FZXinZongYiHeiS',
    localized: '方正新综艺黑 简',
    faces: [
      ['UltraLight', 'FZXINZYHS-UL--GB1-0'],
      ['ExtraLight', 'FZXINZYHS-EL--GB1-0'],
      ['Light', 'FZXINZYHS-L--GB1-0'],
      ['Regular', 'FZXINZYHS-R--GB1-0'],
      ['Medium', 'FZXINZYHS-M--GB1-0'],
      ['DemiBold', 'FZXINZYHS-DB--GB1-0'],
      ['SemiBold', 'FZXINZYHS-SB--GB1-0'],
      ['Bold', 'FZXINZYHS-B--GB1-0'],
      ['ExtraBold', 'FZXINZYHS-EB--GB1-0'],
      ['UltraBold', 'FZXINZYHS-UB--GB1-0'],
      ['Heavy', 'FZXINZYHS-H--GB1-0'],
    ],
  },
  {
    family: 'Alibaba PuHuiTi 2.0',
    localized: '阿里巴巴普惠体 2.0',
    faces: [
      ['35 Thin', 'AlibabaPuHuiTi_2_35_Thin'],
      ['45 Light', 'AlibabaPuHuiTi_2_45_Light'],
      ['55 Regular', 'AlibabaPuHuiTi_2_55_Regular'],
      ['65 Medium', 'AlibabaPuHuiTi_2_65_Medium'],
      ['75 SemiBold', 'AlibabaPuHuiTi_2_75_SemiBold'],
      ['85 Bold', 'AlibabaPuHuiTi_2_85_Bold'],
      ['95 ExtraBold', 'AlibabaPuHuiTi_2_95_ExtraBold'],
      ['105 Heavy', 'AlibabaPuHuiTi_2_105_Heavy'],
      ['115 Black', 'AlibabaPuHuiTi_2_115_Black'],
    ],
  },
  {
    family: 'Alibaba Health Font 2.0 CN',
    localized: '阿里健康体2.0 中文',
    faces: [['45 R', 'AlibabaHealthFont20CN-45R'], ['85 B', 'AlibabaHealthFont20CN-85B']],
  },
  {
    family: 'DingTalk JinBuTi',
    localized: '钉钉进步体',
    faces: [['Regular', 'DingTalk-JinBuTi']],
  },
  {
    family: 'MF MoDeng',
    localized: '造字工房摩登',
    faces: [['Regular', 'MF-MoDeng-Regular']],
  },
  {
    family: 'DINPro',
    faces: [['Regular', 'DINPro-Regular']],
  },
] as const;

function fontKey(family: string, style: string): string {
  return `${family}:${style.trim() || 'Regular'}`.replace(/\s+/g, '').toLowerCase();
}

const aliases = new Map<string, string>();
const fontNames = new Map<string, { family: string; style: string }>();

for (const entry of FONT_FAMILIES) {
  const { family, faces } = entry;
  const displayNames = 'localized' in entry ? [family, entry.localized] : [family];
  for (const [style, postScriptName] of faces) {
    fontNames.set(postScriptName, { family, style });
    for (const name of displayNames) {
      aliases.set(fontKey(name, style), postScriptName);
      // Some font versions expose the weight as part of the family name.
      aliases.set(fontKey(`${name} ${style}`, 'Regular'), postScriptName);
    }
  }
}

export function resolvePostScriptName(family: string, style: string): string | undefined {
  return aliases.get(fontKey(family, style));
}

export function resolveDisplayFont(postScriptName: string): { family: string; style: string } | undefined {
  return fontNames.get(postScriptName);
}
