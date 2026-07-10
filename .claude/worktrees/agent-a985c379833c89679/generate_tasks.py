#!/usr/bin/env python3
"""Generate 20 realistic multi-turn VQA tasks for a beer recommendation agent."""

import json

tasks = []

# ============================================================
# 1. menu_recommend (4 tasks)
# ============================================================

tasks.append({
    "id": "vqa_menu_recommend_1",
    "source": "synthetic",
    "sourceUrl": "",
    "imageUrl": "https://placehold.co/400x600/1a1a2e/eee?text=Beer+Menu+IPA+Selection",
    "title": "酒吧菜单推荐 — IPA爱好者",
    "candidateBeerName": "Pliny the Elder",
    "description": "用户上传酒吧酒单图片，表示喜欢IPA想尝试苦味较重的。多轮对话中先让用户描述喜好，再推荐酒单上的IPA。",
    "query": json.dumps([
        {"role": "user", "content": "我发了一张我们这酒吧的酒单照片，你能帮我看看有什么好酒吗？"},
        {"role": "user", "content": "我比较喜欢IPA，苦味重一点的那种，有没有推荐的？"},
        {"role": "assistant", "content": "我看到酒单上有几款IPA：Pliny the Elder（Russian River，双倍IPA，8%ABV）、Heady Topper（The Alchemist，双倍IPA，8%ABV）、还有一款本地IPA。Pliny the Elder是非常经典的西海岸双倍IPA，苦度适中偏高，柑橘松脂香气浓郁，评分4.49，强烈推荐！"},
        {"role": "user", "content": "Pliny the Elder听起来不错！不过8度会不会太烈了？我平时喝6度左右的。"}
    ]),
    "questions": [
        {"id": "intent_match", "type": "yesno", "prompt": "意图是否正确识别为menu_recommend？"},
        {"id": "beer_identified", "type": "text", "prompt": "识别出的啤酒名称"},
        {"id": "reply_quality", "type": "select", "prompt": "回复质量", "options": ["好", "一般", "差"]}
    ],
    "labels": {},
    "status": "pending",
    "createdAt": "2026-07-10T10:00:00.000Z",
    "updatedAt": "2026-07-10T10:00:00.000Z"
})

tasks.append({
    "id": "vqa_menu_recommend_2",
    "source": "synthetic",
    "sourceUrl": "",
    "imageUrl": "https://placehold.co/400x600/1a1a2e/eee?text=Beer+Menu+Stout+Night",
    "title": "酒吧菜单推荐 — 世涛爱好者",
    "candidateBeerName": "Bourbon County Brand Stout Vanilla Rye",
    "description": "用户上传酒单图片，想要尝试世涛/黑啤，让AI推荐浓郁口感的选择。",
    "query": json.dumps([
        {"role": "user", "content": "帮我看看这张酒单上有哪些世涛（stout）可以选？"},
        {"role": "assistant", "content": "酒单上的世涛有：Bourbon County Brand Stout Vanilla Rye（Goose Island，13.6%ABV）、Founders Breakfast Stout、还有一款本地牛奶世涛。BCBS Vanilla Rye是桶陈波本世涛，香草和黑麦桶风味非常浓郁。"},
        {"role": "user", "content": "BCBS听起来很厉害，但13.6度有点吓人哈哈。有没有度数低一点但同样醇厚的？"},
        {"role": "assistant", "content": "Founders Breakfast Stout大概8.3%ABV，咖啡和巧克力风味很足，也很醇厚但不至于太烈。或者那款本地牛奶世涛通常在6%左右，口感顺滑。您平时更喜欢咖啡味重的还是偏甜的世涛？"},
        {"role": "user", "content": "咖啡味重的吧，那就来Founders Breakfast Stout试试！"}
    ]),
    "questions": [
        {"id": "intent_match", "type": "yesno", "prompt": "意图是否正确识别为menu_recommend？"},
        {"id": "beer_identified", "type": "text", "prompt": "推荐了哪款世涛？"},
        {"id": "reply_quality", "type": "select", "prompt": "回复质量", "options": ["好", "一般", "差"]}
    ],
    "labels": {},
    "status": "pending",
    "createdAt": "2026-07-10T10:01:00.000Z",
    "updatedAt": "2026-07-10T10:01:00.000Z"
})

tasks.append({
    "id": "vqa_menu_recommend_3",
    "source": "synthetic",
    "sourceUrl": "",
    "imageUrl": "https://placehold.co/400x600/1a1a2e/eee?text=Beer+Menu+Sour+Ale",
    "title": "酒吧菜单推荐 — 酸啤入门者",
    "candidateBeerName": "Rodenbach Caractère Rouge",
    "description": "用户从未喝过酸啤，上传酒单想尝试酸啤酒，让AI推荐入门级酸啤。",
    "query": json.dumps([
        {"role": "user", "content": "这张照片是我们这边精酿吧的酒单，我从来没喝过酸啤酒，想试试但不知道选哪个好。"},
        {"role": "assistant", "content": "酸啤酒风格很丰富！我看酒单上有几款酸啤：Rodenbach Caractère Rouge（Flanders Red Ale，7%ABV，评分4.15）、Oude Tart（The Bruery，Flanders Red，8%ABV）、还有一款果泥酸。作为入门推荐Rodenbach Caractère Rouge，它是红酒桶陈酿的酸艾尔，酸味温和有红果风味，很适合初学者。"},
        {"role": "user", "content": "Flanders Red是什么风格？会不会太酸像喝醋一样？"},
        {"role": "assistant", "content": "Flanders Red Ale是比利时传统酸艾尔，在橡木桶中陈酿，酸度类似红酒而非白醋——入口先是清新的果酸，然后有淡淡的橡木和香草味收尾。Rodenbach Caractère Rouge还加了酸樱桃和覆盆子，果味很突出，不会尖酸。建议你点一杯试试，如果不习惯酸味可以配点奶酪小食中和。"},
        {"role": "user", "content": "好，那就来一杯Rodenbach！对了这个配什么吃的比较好？"}
    ]),
    "questions": [
        {"id": "intent_match", "type": "yesno", "prompt": "意图是否正确识别为menu_recommend？"},
        {"id": "beer_identified", "type": "text", "prompt": "推荐了哪款酸啤？"},
        {"id": "reply_quality", "type": "select", "prompt": "回复质量", "options": ["好", "一般", "差"]}
    ],
    "labels": {},
    "status": "pending",
    "createdAt": "2026-07-10T10:02:00.000Z",
    "updatedAt": "2026-07-10T10:02:00.000Z"
})

tasks.append({
    "id": "vqa_menu_recommend_4",
    "source": "synthetic",
    "sourceUrl": "",
    "imageUrl": "https://placehold.co/400x600/1a1a2e/eee?text=Beer+Menu+Belgian+Selection",
    "title": "酒吧菜单推荐 — 比利时啤酒选择困难",
    "candidateBeerName": "Tripel Karmeliet",
    "description": "用户面对酒单上多款比利时啤酒不知如何选择，让AI根据个人口味偏好推荐。",
    "query": json.dumps([
        {"role": "user", "content": "酒单上比利时啤酒好多啊，我选择困难了。Tripel Karmeliet、De Garre、Curieux这三款有什么区别？"},
        {"role": "assistant", "content": "这三款都是比利时Tripel风格，但各有特色：Tripel Karmeliet（Bosteels，8.4%ABV，评分3.98）经典顺滑，三种谷物酿造口感层次丰富；De Garre（Van Steenberge，11%ABV，评分4.09）烈度更高，酒体饱满；Curieux（Allagash，10.2%ABV，评分4.04）是波本桶陈酿的Tripel，有独特的香草和橡木风味。"},
        {"role": "user", "content": "我想要没那么烈但又风味足的，Tripel Karmeliet好像比较平衡？"},
        {"role": "assistant", "content": "对的，Tripel Karmeliet是最均衡的选择。8.4%不算太低但入口非常顺滑，小麦、燕麦和大麦三种谷物带来丰富的层次感，有香蕉和丁香的酯香，收尾干爽。作为比利时Tripel的标杆之作，是绝对不会出错的选择。"},
        {"role": "user", "content": "好就它了！对了，这酒配什么餐比较好？"},
        {"role": "assistant", "content": "Tripel Karmeliet非常适合搭配比利时传统菜——青口贝（moules frites）是绝配，或者配白酱意面、烤鸡、淡味奶酪如格鲁耶尔。不建议配太辣或太甜的菜。祝你好酒量！"}
    ]),
    "questions": [
        {"id": "intent_match", "type": "yesno", "prompt": "意图是否正确识别为menu_recommend？"},
        {"id": "beer_identified", "type": "text", "prompt": "推荐了哪款啤酒？"},
        {"id": "reply_quality", "type": "select", "prompt": "回复质量", "options": ["好", "一般", "差"]}
    ],
    "labels": {},
    "status": "pending",
    "createdAt": "2026-07-10T10:03:00.000Z",
    "updatedAt": "2026-07-10T10:03:00.000Z"
})

# ============================================================
# 2. label_check (2 tasks)
# ============================================================

tasks.append({
    "id": "vqa_label_check_1",
    "source": "synthetic",
    "sourceUrl": "",
    "imageUrl": "https://placehold.co/400x600/1a1a2e/eee?text=Beer+Label+Heady+Topper+Date",
    "title": "罐装日期检查 — Heady Topper",
    "candidateBeerName": "Heady Topper",
    "description": "用户拍了Heady Topper罐装底部照片，想知道生产日期或保质期。",
    "query": json.dumps([
        {"role": "user", "content": "我刚买了一罐Heady Topper，照片是罐底的生产日期，你帮我看看这罐新鲜不新鲜？"},
        {"role": "user", "content": "日期那行数字是 24032，我不太确定这是什么格式。"},
        {"role": "assistant", "content": "Heady Topper使用儒略日（Julian date）格式：24代表2024年，032代表第32天（约2月1日）。所以这罐是2024年2月1日罐装的。双倍IPA建议在罐装后3个月内饮用最佳，现在已经是2026年7月，时间有点久了，建议尽快喝掉或者找店家换一罐更新鲜的。"},
        {"role": "user", "content": "啊已经两年多了！那口感会差很多吗？"},
        {"role": "assistant", "content": "双倍IPA的啤酒花香气会随时间衰减——新鲜时Heady Topper有强烈的热带水果和松脂香，放久了会变得偏麦芽、焦糖味，苦度可能更突出但香气会明显减少。建议买之前看看罐底日期，尽量选3个月内的。这家店可能库存周转慢，下次可以问问有没有更新批次的。"}
    ]),
    "questions": [
        {"id": "intent_match", "type": "yesno", "prompt": "意图是否正确识别为label_check？"},
        {"id": "beer_identified", "type": "text", "prompt": "识别出的啤酒名称"},
        {"id": "reply_quality", "type": "select", "prompt": "回复质量", "options": ["好", "一般", "差"]}
    ],
    "labels": {},
    "status": "pending",
    "createdAt": "2026-07-10T10:04:00.000Z",
    "updatedAt": "2026-07-10T10:04:00.000Z"
})

tasks.append({
    "id": "vqa_label_check_2",
    "source": "synthetic",
    "sourceUrl": "",
    "imageUrl": "https://placehold.co/400x600/1a1a2e/eee?text=Beer+Label+Zombie+Dust+Expiry",
    "title": "保质期检查 — Zombie Dust 瓶装",
    "candidateBeerName": "Zombie Dust",
    "description": "用户拍了Zombie Dust瓶装标签，想确认保质期或最佳饮用期。",
    "query": json.dumps([
        {"role": "user", "content": "我在酒类专卖店看到一瓶Zombie Dust，拍了瓶身的标签照片，你帮我看看上面的日期信息？"},
        {"role": "user", "content": "瓶身上写的是 BOTTLED ON: 05/22/25，这已经一年多前了，还能买吗？"},
        {"role": "assistant", "content": "Zombie Dust是3 Floyds的American Pale Ale（6.5%ABV），瓶装日期2025年5月22日，到现在约14个月。APA比双倍IPA的啤酒花衰减稍慢一些，但一年以上的APA香气还是会明显下降。不过Zombie Dust以其强烈的柑橘（主要是Citra酒花）风味著称，即使不新鲜也可能还有一定风味。如果价格打折且你不太挑剔的话可以试试，但想体验最佳状态建议找更新鲜的批次。"},
        {"role": "user", "content": "那如果我买了，放冰箱还能放多久？"},
        {"role": "assistant", "content": "买回来放冰箱冷藏（4°C左右）可以减缓老化，但已经瓶装14个月了，建议1-2周内喝掉，不要再存放。喝的时候注意不要阳光直射。说真的，如果你对IPA的香气有要求，这瓶可能不会让你惊艳——Zombie Dust的新鲜体验是非常惊艳的！"}
    ]),
    "questions": [
        {"id": "intent_match", "type": "yesno", "prompt": "意图是否正确识别为label_check？"},
        {"id": "beer_identified", "type": "text", "prompt": "识别出的啤酒名称"},
        {"id": "reply_quality", "type": "select", "prompt": "回复质量", "options": ["好", "一般", "差"]}
    ],
    "labels": {},
    "status": "pending",
    "createdAt": "2026-07-10T10:05:00.000Z",
    "updatedAt": "2026-07-10T10:05:00.000Z"
})

# ============================================================
# 3. tasting_feedback (3 tasks)
# ============================================================

tasks.append({
    "id": "vqa_tasting_feedback_1",
    "source": "synthetic",
    "sourceUrl": "",
    "imageUrl": "https://placehold.co/400x600/1a1a2e/eee?text=Pseudo+Sue+Glass",
    "title": "品鉴反馈 — Pseudo Sue 初体验",
    "candidateBeerName": "Pseudo Sue",
    "description": "用户第一次喝Pseudo Sue，描述品尝感受并询问风格特征。",
    "query": json.dumps([
        {"role": "user", "content": "我刚喝了一口朋友推荐的Pseudo Sue，感觉好惊艳啊！闻起来像热带水果炸弹，喝下去很顺滑完全不苦，这是IPA吗？怎么跟我之前喝的IPA不一样？"},
        {"role": "assistant", "content": "Pseudo Sue确实是Toppling Goliath的American Pale Ale（5.8%ABV），虽然很多酒友把它当NEIPA喝。它用了大量Citra酒花单一酿造，所以有浓郁的芒果、百香果、柑橘香气。它的苦度（IBU）不高，加上干投酒花带来的果汁感，所以喝起来不觉得苦，这正是它受欢迎的原因之一！"},
        {"role": "user", "content": "原来如此！难怪我觉得像在喝果汁。那我打分的话，香气我给4.5/5，口感4/5，总体4.2/5，算高吗？"},
        {"role": "assistant", "content": "4.2/5是非常高的分数了！Untappd上Pseudo Sue的综合评分是4.1，你给的分数略高于平均水平，说明你很欣赏这种风格。如果你喜欢这种果汁感强又不苦的啤酒，我还可以推荐Toppling Goliath的同门——King Sue（双倍NEIPA，7.8%ABV）或者Tree House的Lights On（5.6%APA），都是类似风格但更上一层楼的选择。"}
    ]),
    "questions": [
        {"id": "intent_match", "type": "yesno", "prompt": "意图是否正确识别为tasting_feedback？"},
        {"id": "beer_identified", "type": "text", "prompt": "识别出的啤酒名称"},
        {"id": "reply_quality", "type": "select", "prompt": "回复质量", "options": ["好", "一般", "差"]}
    ],
    "labels": {},
    "status": "pending",
    "createdAt": "2026-07-10T10:06:00.000Z",
    "updatedAt": "2026-07-10T10:06:00.000Z"
})

tasks.append({
    "id": "vqa_tasting_feedback_2",
    "source": "synthetic",
    "sourceUrl": "",
    "imageUrl": "https://placehold.co/400x600/1a1a2e/eee?text=Parabola+Stout+Glass",
    "title": "品鉴反馈 — 初次尝试桶陈世涛",
    "candidateBeerName": "Parabola",
    "description": "用户第一次喝Firestone Walker的Parabola桶陈世涛，分享感受并讨论桶陈工艺。",
    "query": json.dumps([
        {"role": "user", "content": "今天开了一瓶Parabola！天呐14.1%的酒精度完全不像，入口是浓烈的波本桶味、黑巧克力、焦糖，还有一点橡木和香草。这酒也太复杂了吧，不过一瓶下肚已经有点晕了哈哈。"},
        {"role": "assistant", "content": "Firestone Walker的Parabola（14.1%ABV，评分4.42）是Russian Imperial Stout中的传奇！它在波本桶中陈酿了整整一年，所以波本、香草、橡木的味道非常突出。高酒精度被浓郁的烘焙麦芽和巧克力风味完美掩盖，这就是\"危险\"的桶陈世涛的特点——喝起来不觉得烈，但后劲十足！"},
        {"role": "user", "content": "太危险了，我喝了半瓶就开始飘了哈哈。这个酒放几年会不会更好喝？"},
        {"role": "assistant", "content": "Parabola非常适合陈年！桶陈世涛在瓶中会继续演化——2-3年后波本和酒精感会融合得更圆润，出现更多的焦糖、黑樱桃、皮革的层次。不过要注意存放在阴凉避光处（12-15°C最佳），卧放保持瓶塞湿润。很多人会买两瓶——一瓶现在喝，一瓶陈个3-5年再对比着喝，体验完全不同！"}
    ]),
    "questions": [
        {"id": "intent_match", "type": "yesno", "prompt": "意图是否正确识别为tasting_feedback？"},
        {"id": "beer_identified", "type": "text", "prompt": "识别出的啤酒名称"},
        {"id": "reply_quality", "type": "select", "prompt": "回复质量", "options": ["好", "一般", "差"]}
    ],
    "labels": {},
    "status": "pending",
    "createdAt": "2026-07-10T10:07:00.000Z",
    "updatedAt": "2026-07-10T10:07:00.000Z"
})

tasks.append({
    "id": "vqa_tasting_feedback_3",
    "source": "synthetic",
    "sourceUrl": "",
    "imageUrl": "https://placehold.co/400x600/1a1a2e/eee?text=Iris+Cantillon+Glass",
    "title": "品鉴反馈 — Cantillon Iris 兰比克体验",
    "candidateBeerName": "Iris",
    "description": "用户第一次喝Cantillon的兰比克，感受独特的野菌风味并询问酿造工艺。",
    "query": json.dumps([
        {"role": "user", "content": "哇，这瓶Iris太神奇了！开瓶就是一股马厩味和酸味，喝起来干干的，有柠檬和一点霉香，完全不像普通啤酒！"},
        {"role": "assistant", "content": "Cantillon的Iris（5%ABV，评分4.25）是非常经典的兰比克（Lambic），而且是Cantillon唯一使用未发芽小麦的版本。你闻到的\"马厩味\"来自野生酵母Brettanomyces和乳酸菌的天然发酵——这是兰比克的标志性风味。它完全自然发酵，不添加任何商业酵母，所以每一批都有微妙差异。"},
        {"role": "user", "content": "原来那些味道是野菌带来的！不过我有点喝不惯，有没有类似但没那么野的风格推荐？"},
        {"role": "assistant", "content": "如果你喜欢酸但觉得兰比克太野，可以试试柏林小麦（Berliner Weisse）或果酸——比如Firestone Walker的Breƫa Weisse（4.9%ABV，评分3.98），同样是野菌发酵但加入了乳酸菌，酸度更清爽，果味更突出。或者Cantillon自己也有添加水果的版本（比如Fou'Foune是杏子兰比克），果味可以中和一部分野菌味，更容易入口。"}
    ]),
    "questions": [
        {"id": "intent_match", "type": "yesno", "prompt": "意图是否正确识别为tasting_feedback？"},
        {"id": "beer_identified", "type": "text", "prompt": "识别出的啤酒名称"},
        {"id": "reply_quality", "type": "select", "prompt": "回复质量", "options": ["好", "一般", "差"]}
    ],
    "labels": {},
    "status": "pending",
    "createdAt": "2026-07-10T10:08:00.000Z",
    "updatedAt": "2026-07-10T10:08:00.000Z"
})

# ============================================================
# 4. beer_knowledge (3 tasks)
# ============================================================

tasks.append({
    "id": "vqa_beer_knowledge_1",
    "source": "synthetic",
    "sourceUrl": "",
    "imageUrl": "https://placehold.co/400x600/1a1a2e/eee?text=IPA+vs+Lager+Styles",
    "title": "啤酒知识 — IPA和拉格的区别",
    "candidateBeerName": "",
    "description": "用户想了解IPA和拉格啤酒的区别，包括酿造工艺和风味差异。",
    "query": json.dumps([
        {"role": "user", "content": "我经常喝酒但分不清IPA和拉格（Lager）到底有什么区别？不只是苦不苦的问题。"},
        {"role": "assistant", "content": "好问题！核心区别在发酵工艺和酵母：Lager用底层酵母在低温（7-13°C）发酵，时间较长，口感干净清爽；IPA（Ale的一种）用顶层酵母在室温（18-24°C）发酵，会产生更多酯香（果味）。另外IPA大量使用啤酒花（干投或煮沸加入），所以苦度和香气都更强烈。简单说：Lager重清爽麦芽味，IPA重酒花香和苦味。"},
        {"role": "user", "content": "那皮尔森（Pilsner）属于拉格吗？我喝过捷克的皮尔森，感觉比普通拉格更香。还有，世涛也是艾尔吗？"},
        {"role": "assistant", "content": "是的！皮尔森是拉格的一个子风格——起源于捷克比尔森市，用Saaz酒花，麦芽香气更突出。世涛也是艾尔（顶层发酵），但用的是烘焙大麦，所以有咖啡、黑巧克力的风味。所以你可以这么记：顶层发酵（Ale）≈ IPA、世涛、酸啤等风味浓郁的类型；底层发酵（Lager）≈ 普通啤酒、皮尔森等清爽类型。但两者都有非常多的子风格，值得慢慢探索！"}
    ]),
    "questions": [
        {"id": "intent_match", "type": "yesno", "prompt": "意图是否正确识别为beer_knowledge？"},
        {"id": "beer_identified", "type": "text", "prompt": "识别出的啤酒名称（不适用）"},
        {"id": "reply_quality", "type": "select", "prompt": "回复质量", "options": ["好", "一般", "差"]}
    ],
    "labels": {},
    "status": "pending",
    "createdAt": "2026-07-10T10:09:00.000Z",
    "updatedAt": "2026-07-10T10:09:00.000Z"
})

tasks.append({
    "id": "vqa_beer_knowledge_2",
    "source": "synthetic",
    "sourceUrl": "",
    "imageUrl": "https://placehold.co/400x600/1a1a2e/eee?text=NEIPA+Hazy+Style",
    "title": "啤酒知识 — 浑浊IPA（NEIPA）的由来",
    "candidateBeerName": "",
    "description": "用户好奇为什么浑浊IPA这么火，询问NEIPA的历史和酿造特点。",
    "query": json.dumps([
        {"role": "user", "content": "现在精酿圈好像都在喝那种浑浊的、像果汁一样的IPA，这风格是怎么来的？为什么它这么浑？"},
        {"role": "assistant", "content": "浑浊IPA（New England IPA / NEIPA）起源于美国佛蒙特州的The Alchemist酒厂——他们的Heady Topper（评分4.52，290K+评价）被认为是这个风格的开创者之一。浑浊的原因是大量干投啤酒花和特殊的酵母菌株，加上不经过滤和未使用絮凝剂，保留了蛋白质-多酚复合物，所以看起来浑浊。酿造上大量使用燕麦和小麦增加口感，苦度低但香气爆炸。"},
        {"role": "user", "content": "所以Heady Topper是鼻祖？那Tree House和Hill Farmstead呢？我听说他们的也很厉害。"},
        {"role": "assistant", "content": "没错！Tree House的King JJJuliusss（4.66评分）和Hill Farmstead的Double Citra（4.48评分）也都是NEIPA的顶级代表。Tree House以浓郁果汁感和超顺滑口感闻名，Hill Farmstead则以平衡优雅著称。三家酒厂都在佛蒙特州，该地区被称为\"NEIPA的圣城\"。它们各有千秋——Alchemist开创了风格，Tree House把果汁感推向极致，Hill Farmstead展现了细腻的平衡美学。"}
    ]),
    "questions": [
        {"id": "intent_match", "type": "yesno", "prompt": "意图是否正确识别为beer_knowledge？"},
        {"id": "beer_identified", "type": "text", "prompt": "识别出的啤酒名称（不适用）"},
        {"id": "reply_quality", "type": "select", "prompt": "回复质量", "options": ["好", "一般", "差"]}
    ],
    "labels": {},
    "status": "pending",
    "createdAt": "2026-07-10T10:10:00.000Z",
    "updatedAt": "2026-07-10T10:10:00.000Z"
})

tasks.append({
    "id": "vqa_beer_knowledge_3",
    "source": "synthetic",
    "sourceUrl": "",
    "imageUrl": "https://placehold.co/400x600/1a1a2e/eee?text=Bourbon+Barrel+Aged+Stout",
    "title": "啤酒知识 — 波本桶陈酿工艺",
    "candidateBeerName": "",
    "description": "用户想了解为什么波本桶陈酿的世涛这么受欢迎，以及桶陈工艺的具体流程。",
    "query": json.dumps([
        {"role": "user", "content": "为什么桶陈世涛这么受欢迎？我看Goose Island的BCBS每年发售都排长队，一瓶难求。"},
        {"role": "assistant", "content": "桶陈世涛的魅力在于风味的复杂度和层次感。以Goose Island的Bourbon County Brand Stout为例，它在陈年波本桶中陈酿8-12个月，酒体会从桶中吸收：波本酒的香草、焦糖、橡木风味，同时世涛本身的烘焙麦芽（咖啡、黑巧）与之融合，再加上桶内残留的波本酒精带来微妙的温暖感。每年限量发售+风味随桶龄变化，让收藏和品鉴都充满乐趣。"},
        {"role": "user", "content": "听起来好复杂！所有的桶都能用来陈酿啤酒吗？用什么桶最好？"},
        {"role": "assistant", "content": "不是所有桶都适合！最常见的是波本桶（Bourbon barrels），因为美国法律规定波本必须用新烤橡木桶陈酿，所以用过的桶非常便宜且风味丰富。其次是葡萄酒桶（红酒、雪莉、波特桶）和朗姆酒桶。关键要素：桶之前装过什么酒决定了赋予的风味类型；桶的烘烤程度（轻/中/重）影响橡木单宁和香草味强度；陈酿时间长短也至关重要——太短风味不足，太长则橡木味过重。好的桶陈啤酒是时间与耐心的艺术。"}
    ]),
    "questions": [
        {"id": "intent_match", "type": "yesno", "prompt": "意图是否正确识别为beer_knowledge？"},
        {"id": "beer_identified", "type": "text", "prompt": "识别出的啤酒名称（不适用）"},
        {"id": "reply_quality", "type": "select", "prompt": "回复质量", "options": ["好", "一般", "差"]}
    ],
    "labels": {},
    "status": "pending",
    "createdAt": "2026-07-10T10:11:00.000Z",
    "updatedAt": "2026-07-10T10:11:00.000Z"
})

# ============================================================
# 5. profile_query (2 tasks)
# ============================================================

tasks.append({
    "id": "vqa_profile_query_1",
    "source": "synthetic",
    "sourceUrl": "",
    "imageUrl": "https://placehold.co/400x600/1a1a2e/eee?text=Taste+Profile+Check",
    "title": "口味偏好查询 — 回顾和更新偏好",
    "candidateBeerName": "",
    "description": "用户想查看自己的口味档案，看系统记录了什么偏好。",
    "query": json.dumps([
        {"role": "user", "content": "我记得你之前记录过我的口味偏好，能帮我看看我到底喜欢什么类型的啤酒吗？"},
        {"role": "assistant", "content": "根据记录，您之前提到喜欢苦味重一些的IPA（特别点赞了Pliny the Elder），也尝试过世涛但觉得13%以上的太烈。您对酸啤持开放态度但还没找到合适的入门款。总结来说：偏好IPA和烈度适中的深色啤酒，对桶陈风味有兴趣。这是目前的记录，需要更新或补充什么吗？"},
        {"role": "user", "content": "对，最近我喝了几款酸啤之后发现其实挺喜欢的，特别是那种果味酸啤，能帮我更新一下口味档案吗？"},
        {"role": "assistant", "content": "好的，已更新您的口味档案！新增：喜欢果味酸啤（如PB&J Mixtape类），对Flanders Red和柏林小麦持开放态度。现在您的偏好范围更广了——从IPA到果酸都有涉猎。下次推荐我可以结合这个新信息，给您更精准的建议。"}
    ]),
    "questions": [
        {"id": "intent_match", "type": "yesno", "prompt": "意图是否正确识别为profile_query？"},
        {"id": "beer_identified", "type": "text", "prompt": "识别出的啤酒名称（不适用）"},
        {"id": "reply_quality", "type": "select", "prompt": "回复质量", "options": ["好", "一般", "差"]}
    ],
    "labels": {},
    "status": "pending",
    "createdAt": "2026-07-10T10:12:00.000Z",
    "updatedAt": "2026-07-10T10:12:00.000Z"
})

tasks.append({
    "id": "vqa_profile_query_2",
    "source": "synthetic",
    "sourceUrl": "",
    "imageUrl": "https://placehold.co/400x600/1a1a2e/eee?text=What+Should+I+Drink",
    "title": "口味偏好查询 — 根据心情选酒",
    "candidateBeerName": "King Sue",
    "description": "用户今天心情好想喝点特别的，让AI根据历史偏好推荐一款啤酒。",
    "query": json.dumps([
        {"role": "user", "content": "今天发工资了心情好，想去精酿吧喝一杯好的。你之前知道我口味，帮我推荐一款？"},
        {"role": "assistant", "content": "根据您之前的口味记录——喜欢IPA但不太能接受太高的ABV（之前觉得8%的Pliny偏烈），同时最近对果汁感强的啤酒表示好感——我推荐King Sue（Toppling Goliath，7.8%ABV，双倍NEIPA，评分4.3）。它是Pseudo Sue的升级版，热带水果香气爆炸但入口顺滑不苦，度数比Pliny略低但风味更浓郁，非常适合庆祝的心情！"},
        {"role": "user", "content": "King Sue听起来不错！不过7.8%会不会跟之前Pliny差不多？我还是有点担心太烈。"},
        {"role": "assistant", "content": "虽然ABV接近8%，但King Sue是NEIPA风格，酒精度被浓郁的水果香气和顺滑口感掩盖得很好，喝起来感觉比实际度数低。不像西海岸IPA那种酒精感明显。建议你慢慢喝，配点炸鸡或者薯条，体验会更好。如果实在担心，可以先点一杯试试！"}
    ]),
    "questions": [
        {"id": "intent_match", "type": "yesno", "prompt": "意图是否正确识别为profile_query？"},
        {"id": "beer_identified", "type": "text", "prompt": "推荐了哪款啤酒？"},
        {"id": "reply_quality", "type": "select", "prompt": "回复质量", "options": ["好", "一般", "差"]}
    ],
    "labels": {},
    "status": "pending",
    "createdAt": "2026-07-10T10:13:00.000Z",
    "updatedAt": "2026-07-10T10:13:00.000Z"
})

# ============================================================
# 6. memory_correction (2 tasks)
# ============================================================

tasks.append({
    "id": "vqa_memory_correction_1",
    "source": "synthetic",
    "sourceUrl": "",
    "imageUrl": "https://placehold.co/400x600/1a1a2e/eee?text=Correction+West+Coast+IPA",
    "title": "记忆修正 — 更正偏好：喜欢西海岸而非NEIPA",
    "candidateBeerName": "",
    "description": "用户发现AI记错了自己的IPA偏好，进行更正。",
    "query": json.dumps([
        {"role": "user", "content": "上次我说喜欢IPA，你给我推荐了好多浑浊IPA（NEIPA），但我其实更喜欢西海岸IPA那种清亮、苦味明显的风格。"},
        {"role": "assistant", "content": "明白了，我之前的记录有误！已更新您的偏好：偏好西海岸IPA（West Coast IPA），喜欢清亮酒体和明显的苦味。之前推荐的Heady Topper、King Sue等NEIPA不太适合您，抱歉。我应该推荐Pliny the Elder（Russian River，8%ABV，评分4.49）、Double Citra（Hill Farmstead，8%ABV，评分4.48）这类酒花苦香突出的经典西海岸风格。"},
        {"role": "user", "content": "对对对！Pliny the Elder我喝过，那个就是我想要的。那还有没有类似的推荐？"},
        {"role": "assistant", "content": "西海岸双倍IPA的经典选择还有：Dinner（Maine Beer Company，8.2%ABV，评分4.5）——干净利落的松脂和柑橘风味，苦度明显但平衡；Abner（Hill Farmstead，8.2%ABV，评分4.47）——也是西海岸双倍IPA的标杆。这三款被誉为美国东海岸西海岸IPA的三大神作！"}
    ]),
    "questions": [
        {"id": "intent_match", "type": "yesno", "prompt": "意图是否正确识别为memory_correction？"},
        {"id": "beer_identified", "type": "text", "prompt": "更正后推荐了哪些啤酒？"},
        {"id": "reply_quality", "type": "select", "prompt": "回复质量", "options": ["好", "一般", "差"]}
    ],
    "labels": {},
    "status": "pending",
    "createdAt": "2026-07-10T10:14:00.000Z",
    "updatedAt": "2026-07-10T10:14:00.000Z"
})

tasks.append({
    "id": "vqa_memory_correction_2",
    "source": "synthetic",
    "sourceUrl": "",
    "imageUrl": "https://placehold.co/400x600/1a1a2e/eee?text=Correction+Bourbon+Stout",
    "title": "记忆修正 — 更正ABV承受能力",
    "candidateBeerName": "",
    "description": "用户之前说怕高ABV的世涛，尝试后发现其实可以接受，要求更正口味档案。",
    "query": json.dumps([
        {"role": "user", "content": "我之前跟你说我喝不了高度数世涛，但我最近试了Bourbon County Brand Stout Vanilla Rye（13.6%），发现其实很好喝！我的耐受度好像被低估了。"},
        {"role": "assistant", "content": "好的，已更正您的口味档案！之前记录为\"高ABV世涛偏烈\"已更新为\"可以接受13-14%ABV的桶陈世涛，偏好波本桶风味\"。BCBS Vanilla Rye（评分4.73）确实是桶陈世涛的顶级之作——香草味和黑麦桶的辛香搭配非常完美，说明您的味蕾已经进阶了！"},
        {"role": "user", "content": "确实！我现在想尝试更多桶陈世涛，有没有其他推荐的？"},
        {"role": "assistant", "content": "既然您能接受BCBS的水平，推荐：Parabola（Firestone Walker，14.1%ABV，评分4.42）——波本桶陈的Russian Imperial Stout，黑巧和焦糖味浓郁；Darkness Barrel-Aged（Surly，12%ABV，评分4.47）——黑麦桶陈，辛香和深色水果风味。如果遇到Bourbon Barrel Aged Expedition Stout（Bell's，13.4%ABV，评分4.41）也值得一试。不过建议从12%左右慢慢往上喝，避免一步到15%+的巨兽！"}
    ]),
    "questions": [
        {"id": "intent_match", "type": "yesno", "prompt": "意图是否正确识别为memory_correction？"},
        {"id": "beer_identified", "type": "text", "prompt": "更正后推荐了哪些啤酒？"},
        {"id": "reply_quality", "type": "select", "prompt": "回复质量", "options": ["好", "一般", "差"]}
    ],
    "labels": {},
    "status": "pending",
    "createdAt": "2026-07-10T10:15:00.000Z",
    "updatedAt": "2026-07-10T10:15:00.000Z"
})

# ============================================================
# 7. follow_up_filter (2 tasks)
# ============================================================

tasks.append({
    "id": "vqa_follow_up_filter_1",
    "source": "synthetic",
    "sourceUrl": "",
    "imageUrl": "https://placehold.co/400x600/1a1a2e/eee?text=Filter+Not+Too+Bitter",
    "title": "追问过滤 — IPA推荐后要求不要太苦",
    "candidateBeerName": "Pseudo Sue",
    "description": "AI推荐了几款IPA后，用户补充说不想太苦，要求过滤推荐。",
    "query": json.dumps([
        {"role": "user", "content": "我想喝IPA，有什么推荐的？"},
        {"role": "assistant", "content": "推荐以下几款IPA：Pliny the Elder（西海岸双倍IPA，8%ABV，评分4.49）、Heady Topper（NEIPA鼻祖，8%ABV，评分4.52）、King Sue（双倍NEIPA，7.8%ABV，评分4.3）。"},
        {"role": "user", "content": "等一下，我说得不清楚——我不想要太苦的IPA，上次喝Pliny觉得苦味有点重了。有没有没那么苦但香气足的？"},
        {"role": "assistant", "content": "明白了，您想要低苦度的IPA！那我推荐：Pseudo Sue（Toppling Goliath，5.8%ABV，APA风格但IPA级香气，评分4.1）——苦度很低但Citra酒花香气爆炸；或者King Sue（7.8%ABV，评分4.3）——虽然双倍但NEIPA风格本身苦度就低，更偏向果汁感。这两款都是香气浓郁但几乎不苦的好选择！"},
        {"role": "user", "content": "Pseudo Sue好像不错，5.8度也挺适合今天慢慢喝的。它的苦度大概有多少IBU？"},
        {"role": "assistant", "content": "Pseudo Sue的IBU大约在30-35左右，远低于Pliny the Elder的约100IBU。普通淡拉格大概10-15IBU，所以30-35的苦度只是略有感觉，更多是饱满的果汁风味。5.8%的酒精度也很适合慢慢品一晚上！"}
    ]),
    "questions": [
        {"id": "intent_match", "type": "yesno", "prompt": "意图是否正确识别为follow_up_filter？"},
        {"id": "beer_identified", "type": "text", "prompt": "最终推荐了哪款啤酒？"},
        {"id": "reply_quality", "type": "select", "prompt": "回复质量", "options": ["好", "一般", "差"]}
    ],
    "labels": {},
    "status": "pending",
    "createdAt": "2026-07-10T10:16:00.000Z",
    "updatedAt": "2026-07-10T10:16:00.000Z"
})

tasks.append({
    "id": "vqa_follow_up_filter_2",
    "source": "synthetic",
    "sourceUrl": "",
    "imageUrl": "https://placehold.co/400x600/1a1a2e/eee?text=Filter+Budget+Friendly",
    "title": "追问过滤 — 世涛推荐后要求性价比高的",
    "candidateBeerName": "Founders Breakfast Stout",
    "description": "AI推荐了多款高端世涛，用户补充说预算有限想要性价比高的日常选择。",
    "query": json.dumps([
        {"role": "user", "content": "最近天冷想喝点世涛，有什么推荐？"},
        {"role": "assistant", "content": "世涛推荐：Parabola（Firestone Walker，14.1%ABV，评分4.42）、BCBS Vanilla Rye（Goose Island，13.6%ABV，评分4.73）、Darkness Barrel-Aged（Surly，12%ABV，评分4.47）。"},
        {"role": "user", "content": "这些桶陈世涛确实好，但一瓶都几百块了，有没有日常喝不心疼的？"},
        {"role": "assistant", "content": "明白，推荐高性价比的日常世涛：Founders Breakfast Stout（Founders，8.3%ABV，评分4.18）——咖啡巧克力风味，价格亲民约¥30-40/瓶，是非常经典的日常世涛；Hold On To Sunshine（Tree House，7.6%ABV，评分4.42）——牛奶世涛口感顺滑，性价比也很高。这两款虽然不是桶陈但风味非常出色，适合日常饮用。"},
        {"role": "user", "content": "Founders Breakfast Stout我听说过！它真的有咖啡味吗？还是只是噱头？"},
        {"role": "assistant", "content": "不是噱头！Founders Breakfast Stout确实在酿造中加入了浓缩咖啡和巧克力，加上烘焙麦芽的天然咖啡风味，三重咖啡感叠加。闻起来像一杯黑咖啡加黑巧，入口有烘焙咖啡和燕麦的顺滑感。它甚至被很多咖啡爱好者当作\"液体早餐\"来喝（虽然8.3%ABV不适合早上喝哈哈）。性价比之王，强烈推荐入门！"}
    ]),
    "questions": [
        {"id": "intent_match", "type": "yesno", "prompt": "意图是否正确识别为follow_up_filter？"},
        {"id": "beer_identified", "type": "text", "prompt": "最终推荐了哪款世涛？"},
        {"id": "reply_quality", "type": "select", "prompt": "回复质量", "options": ["好", "一般", "差"]}
    ],
    "labels": {},
    "status": "pending",
    "createdAt": "2026-07-10T10:17:00.000Z",
    "updatedAt": "2026-07-10T10:17:00.000Z"
})

# ============================================================
# 8. unclear (2 tasks)
# ============================================================

tasks.append({
    "id": "vqa_unclear_1",
    "source": "synthetic",
    "sourceUrl": "",
    "imageUrl": "https://placehold.co/400x600/1a1a2e/eee?text=Blurry+Beer+Photo",
    "title": "模糊输入 — 模糊照片+不明确的问题",
    "candidateBeerName": "",
    "description": "用户发了一张模糊的啤酒照片并说\"这个怎么样？\"，AI需要主动询问澄清。",
    "query": json.dumps([
        {"role": "user", "content": "我拍了一张照片（不过有点糊），你帮我看看这个怎么样？"},
        {"role": "user", "content": "就那个啤酒啊，朋友推荐的但我记不清名字了。"},
        {"role": "assistant", "content": "照片比较模糊，我尽力识别——看起来像是一杯深色啤酒，颜色接近深琥珀/黑色，泡沫是米白色的。根据轮廓有可能是世涛或深色艾尔。但图片太模糊了，我看不到酒标或品牌信息。能帮我补充一下吗？比如：1）这是什么风格的啤酒？2）酒精度大概多少？3）在什么场合喝的？"},
        {"role": "user", "content": "哦我记起来了，是Founders的早餐世涛，8.3度，在朋友家喝的。你觉得这个酒怎么样？"},
        {"role": "assistant", "content": "Founders Breakfast Stout是经典中的经典！8.3%ABV，评分4.18。它有浓郁的冷萃咖啡和黑巧克力风味，燕麦带来的丝滑口感，烘焙麦芽的微焦香，喝起来就像一杯液态的摩卡咖啡。很多人把它作为\"世涛入门\"的第一课，但它也深受老酒鬼的喜爱。你朋友品味不错！"}
    ]),
    "questions": [
        {"id": "intent_match", "type": "yesno", "prompt": "意图是否正确识别为unclear/需要澄清？"},
        {"id": "beer_identified", "type": "text", "prompt": "最终识别出哪款啤酒？"},
        {"id": "reply_quality", "type": "select", "prompt": "回复质量", "options": ["好", "一般", "差"]}
    ],
    "labels": {},
    "status": "pending",
    "createdAt": "2026-07-10T10:18:00.000Z",
    "updatedAt": "2026-07-10T10:18:00.000Z"
})

tasks.append({
    "id": "vqa_unclear_2",
    "source": "synthetic",
    "sourceUrl": "",
    "imageUrl": "https://placehold.co/400x600/1a1a2e/eee?text=Menu+or+Label+Ambiguous",
    "title": "模糊输入 — 用户只说\"推荐一个\"没有上下文",
    "candidateBeerName": "",
    "description": "用户只说\"推荐一个\"，没有提供任何背景信息，AI需要主动询问喜好。",
    "query": json.dumps([
        {"role": "user", "content": "帮我推荐一个啤酒吧。"},
        {"role": "assistant", "content": "好的！不过我需要先了解您的偏好才能推荐合适的酒。请问：1）您平时喜欢什么风格的啤酒？（IPA、世涛、酸啤、拉格还是其他？）2）您喜欢苦的还是甜的？3）有没有酒精度偏好的范围？4）您现在是打算去酒吧喝还是在家自己喝？"},
        {"role": "user", "content": "嗯…我其实不太懂啤酒，平时就喝喝雪花青岛。但想试试精酿，又怕太苦喝不惯。"},
        {"role": "assistant", "content": "明白了！从工业拉格转精酿的话，推荐从柔和易饮的风格开始：Lights On（Tree House，5.6%ABV，评分4.23）——美式淡艾，清爽干净但有淡淡的柑橘香，不苦；Marie（Hill Farmstead，5%ABV，评分4.09）——德式Helles拉格，跟你平时喝的风格接近但品质高出几个层次。这两款都是\"精酿入门\"绝佳选择，不会太冲击味蕾，又能让你感受到精酿的魅力！"}
    ]),
    "questions": [
        {"id": "intent_match", "type": "yesno", "prompt": "意图是否正确识别为unclear/需要澄清？"},
        {"id": "beer_identified", "type": "text", "prompt": "推荐了哪款入门啤酒？"},
        {"id": "reply_quality", "type": "select", "prompt": "回复质量", "options": ["好", "一般", "差"]}
    ],
    "labels": {},
    "status": "pending",
    "createdAt": "2026-07-10T10:19:00.000Z",
    "updatedAt": "2026-07-10T10:19:00.000Z"
})

# ============================================================
# Write the file
# ============================================================
output_path = '/Users/Zhuanz/Desktop/beer-lens/data/vqa-tasks/tasks.json'
with open(output_path, 'w', encoding='utf-8') as f:
    json.dump(tasks, f, ensure_ascii=False, indent=2)

print(f"Written {len(tasks)} tasks to {output_path}")
print("Task IDs:")
for t in tasks:
    print(f"  {t['id']}: {t['title']}")