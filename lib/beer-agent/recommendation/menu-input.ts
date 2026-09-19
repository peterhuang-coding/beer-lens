import { lookupChineseBeerName } from "../beer-db/aliases.ts";
export type MenuItem = {
  beerName: string; brewery: string; style: string; menuIndex: number;
  price: number | null; volumeMl: number | null; abv: number; ibu: number | null; rawText: string;
};

const requestLine = /^(?:这里面|这几款|这几杯|有没有|不喝|不想喝|排除|除了|哪(?:款|个|一)|这个|这款|这杯|换一款|再来|清爽|便宜|最便宜|少花|省钱|性价比|划算|单位价|按.*(?:单位价|性价比|总价)|每\s*100\s*(?:ml|毫升)|更苦|更烈|更轻|有.+吗|第\s*[一二三四五六七八九十0-9]+|hello\b|hi\b|你好|在吗|帮我|请|推荐|想喝|我想|今天|预算|不超过|最多|放宽到|调整到|提高到|不要|只要|不苦|不爱苦|低度|苦度|IBU|酒精度|ABV|第一杯|想尝新|换成|改成|看看|选|挑|\d+(?:\.\d+)?\s*(?:元|块)\s*(?:以内|以下))/i;
const breweryHeading = /^(?:京A|高大师|牛啤堂|悠航|道酿|Jing-A|Master Gao)$|(?:酒厂|酒馆|酿造|Brewery|Brewing(?: Company)?)$/i;

const genericStyle = /^(?:(?:west coast|hazy|double|triple|session|imperial|milk)\s+)?(?:IPA|NEIPA|拉格|世涛|小麦|酸啤|lager|stout|sour|wheat|pilsner|wheat beer)$/i;

export function hasNamedMenuItems(items: MenuItem[]): boolean { return items.some(item=>!genericStyle.test(item.beerName)); }

export function parseOrdinalReference(text: string): number | null {
  const match = text.match(/第\s*(\d+|[一二三四五六七八九十]+)\s*(?:款|个|杯)?/);
  if (!match) return null;
  if (/^\d+$/.test(match[1])) return Number(match[1]);
  return parseChineseInteger(match[1]);
}

function parseChineseInteger(value: string): number | null {
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === '十') return 10;
  const tens = value.match(/^([一二三四五六七八九]?)十([一二三四五六七八九]?)$/);
  if (tens) return (tens[1] ? digits[tens[1]] : 1) * 10 + (tens[2] ? digits[tens[2]] : 0);
  if (value.length === 1 && value in digits) return digits[value];
  return null;
}

export function inferStyle(name: string): string {
  if (/hazy|neipa|浑浊/i.test(name)) return 'Hazy IPA';
  if (/ipa|西海岸/i.test(name)) return 'IPA';
  if (/lager|拉格|pils|皮尔森/i.test(name)) return 'Lager';
  if (/wheat|小麦|wit|白啤/i.test(name)) return 'Wheat';
  if (/stout|世涛|porter|波特/i.test(name)) return 'Stout';
  if (/gose|sour|酸|古斯/i.test(name)) return 'Sour';
  return '';
}

/** Deterministic extraction of text menu rows; the raw line always remains available as evidence. */
export function parseMenuInput(text: string): { items: MenuItem[]; requestText: string; isMenu: boolean } {
  const lines = text.split(/[\n\r;；]+/).map(s=>s.trim()).filter(Boolean);
  const request: string[] = []; const items: MenuItem[] = [];
  let heading = ''; let explicit = false;
  for (let line of lines) {
    const header = line.match(/^(?:酒单|菜单|新的?酒单)\s*[:：]\s*(.*)$/);
    if (header) { explicit = true; line = header[1]; if (!line) continue; }
    const namedMatch = line.match(/^(?:帮我|请)?(?:推荐|查一下|看看)\s*([^，,]+?)(?:[，,](.*))?[?？。！!]*$/);
    const namedRequest = namedMatch?.[1]?.trim();
    const explicitName = namedRequest && (lookupChineseBeerName(namedRequest) || (/^[A-Za-z][A-Za-z0-9'’ -]+$/.test(namedRequest) && !genericStyle.test(namedRequest)));
    if (explicitName) { if(namedMatch?.[2]) request.push(namedMatch[2]); line=namedRequest!; }
    else if (requestLine.test(line) || /^(?:酒单|菜单)$/.test(line)) { request.push(line); if (/酒单|菜单/.test(line)) explicit=true; continue; }
    if (breweryHeading.test(line) && lines.length>1) { heading=line; continue; }
    // A second prose clause of a request is not a new menu row. Explicit
    // menus and rows with independent name/price evidence remain extractable.
    if (request.length && !explicit && !lookupChineseBeerName(line) && !/^[A-Za-z][A-Za-z0-9'’ -]+$/.test(line) && !/[¥￥]|\d\s*(?:元|ml|%)/i.test(line)) { request.push(line); continue; }
    const rawText = line;
    const index = line.match(/^#?\s*(\d+)\s*[.、)号]\s*/);
    if (index) line = line.slice(index[0].length);
    let price: number|null = null, volumeMl:number|null = null, abv=0, ibu:number|null=null;
    line = line.replace(/(?:ABV\s*)?(\d+(?:\.\d+)?)\s*%\s*(?:ABV)?/ig, (_,n)=>{ abv=Number(n);return ' '; });
    line = line.replace(/ABV\s*(\d+(?:\.\d+)?)/ig,(_,n)=>{ abv=Number(n);return ' '; });
    line = line.replace(/(?:IBU|苦度)\s*[:：]?\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*IBU\b/ig,(_,a,b)=>{ibu=Number(a??b);return ' ';});
    line = line.replace(/(\d+(?:\.\d+)?)\s*ml/ig,(_,n)=>{volumeMl=Number(n);return ' ';});
    line = line.replace(/[¥￥]\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:元|块)/g,(_,a,b)=>{price=Number(a??b);return ' ';});
    line = line.replace(/(?:^|\s)(\d+(?:\.\d+)?)\s*\/\s*(\d{2,4})(?=\s|$)/g,(_,p,v)=>{price=Number(p);volumeMl=Number(v);return ' ';});
    line = line.replace(/[·/]+/g,' ').trim();
    const trailing = line.match(/\s+(\d+(?:\.\d+)?)\s*$/);
    if (trailing && price==null) {price=Number(trailing[1]);line=line.slice(0,trailing.index).trim();}
    let brewery=heading;
    const pipe=line.split(/\s*\|\s*/).filter(Boolean);
    if (pipe.length>1) { line=pipe[0];brewery=pipe[1]; if(price==null && /^\d+(?:\.\d+)?$/.test(pipe[2]??'')) price=Number(pipe[2]); }
    const split=line.match(/^(.+?)\s+[-—]\s+(.+)$/) ?? line.match(/^(.+?)\s*[（(]([^()（）]+)[）)]\s*$/);
    if(split){line=split[1];brewery=split[2];}
    line=line.replace(/[|·/]+$/,'').trim();
    if (line.length<2) continue;
    items.push({beerName:line,brewery,style:inferStyle(line),menuIndex:index?Number(index[1]):items.length+1,price,volumeMl,abv,ibu,rawText});
  }
  return {items,requestText:request.join('；'),isMenu:explicit || items.length>1 || items.some(i=>i.price!=null || i.volumeMl!=null)};
}
