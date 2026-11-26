// Countries for Kết quả tìm kiếm ở (main/searchregion.js), each named in the user's language.
import { LOCALE } from './i18n.js';

export const REGIONS = (
  'ad ae af ag ai al am ao ar as at au aw az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bw by bz ' +
  'ca cd cf cg ch ci ck cl cm cn co cr cu cv cw cy cz de dj dk dm do dz ec ee eg er es et fi fj fk fm fo fr ' +
  'ga gb gd ge gf gh gi gl gm gn gp gq gr gt gu gw gy hk hn hr ht hu id ie il in iq ir is it jm jo jp ' +
  'ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mg mh mk ml mm mn mo mp mq mr mt mu mv mw mx my mz ' +
  'na nc ne ng ni nl no np nr nz om pa pe pf pg ph pk pl pr ps pt pw py qa re ro rs ru rw ' +
  'sa sb sc sd se sg sh si sk sl sm sn so sr ss st sv sx sy sz tc td tg th tj tl tm tn to tr tt tv tw tz ' +
  'ua ug us uy uz va vc ve vg vi vn vu ws ye za zm zw'
).split(' ');

let names;
export function regionName(cc) {
  if (!cc) return '';
  try {
    names ||= new Intl.DisplayNames([LOCALE], { type: 'region' });
    return names.of(cc.toUpperCase()) || cc.toUpperCase();
  } catch {
    return cc.toUpperCase();
  }
}

// [code, name], by name
export const regionOptions = () => REGIONS.map((cc) => [cc, regionName(cc)]).sort((a, b) => a[1].localeCompare(b[1], LOCALE));
