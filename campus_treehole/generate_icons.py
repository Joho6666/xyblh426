# -*- coding: utf-8 -*-
"""生成校园树洞小程序所有图标和占位图片"""
import os, math
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'images')
os.makedirs(OUT, exist_ok=True)

PRIMARY = '#426089'
TERTIARY = '#635983'
SECONDARY = '#556071'
TERTIARY_CONTAINER = '#d8cafc'
SECONDARY_CONTAINER = '#d8e3f8'
PRIMARY_CONTAINER = '#afcefd'
ON_SURFACE = '#2c3338'
OUTLINE = '#abb3b9'
WHITE = '#ffffff'

def h2r(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def save(name, img):
    img.save(os.path.join(OUT, f'{name}.png'))

# === TabBar 图标 81x81 ===
def tab_icon(name, color, draw_func):
    img = Image.new('RGBA', (81, 81), (0,0,0,0))
    d = ImageDraw.Draw(img)
    draw_func(d, 81, h2r(color))
    save(name, img)

def draw_home(d, s, c):
    d.polygon([(s//2, s//6), (s//6, s//2), (s*5//6, s//2)], fill=c)
    d.rectangle([(s//4, s//2-2), (s*3//4, s*5//6)], fill=c)
    d.rectangle([(s*3//8, s*9//16), (s*5//8, s*5//6)], fill=(255,255,255,255))

def draw_add(d, s, c):
    d.ellipse([(4,4),(s-4,s-4)], fill=c)
    t = max(4, s//12)
    cx = s//2
    a = s//4
    d.rectangle([(cx-a, cx-t), (cx+a, cx+t)], fill=(255,255,255,255))
    d.rectangle([(cx-t, cx-a), (cx+t, cx+a)], fill=(255,255,255,255))

def draw_person(d, s, c):
    cx = s//2
    hr = s//6
    d.ellipse([(cx-hr, s//5), (cx+hr, s//5+hr*2)], fill=c)
    bt = s//5 + hr*2 + 4
    d.chord([(s//5, bt-s//8), (s*4//5, bt+s//3)], 0, 180, fill=c)

tab_icon('tab_home', OUTLINE, draw_home)
tab_icon('tab_home_active', PRIMARY, draw_home)
tab_icon('tab_post', OUTLINE, draw_add)
tab_icon('tab_post_active', PRIMARY, draw_add)
tab_icon('tab_mine', OUTLINE, draw_person)
tab_icon('tab_mine_active', PRIMARY, draw_person)

# === UI 图标 64x64 ===
def ui(name, func, color=ON_SURFACE):
    img = Image.new('RGBA', (64,64), (0,0,0,0))
    d = ImageDraw.Draw(img)
    func(d, 64, h2r(color))
    save(name, img)

def i_search(d,s,c):
    r=s//4; cx=s*2//5; cy=s*2//5; w=max(3,s//16)
    d.ellipse([(cx-r,cy-r),(cx+r,cy+r)], outline=c, width=w)
    d.line([(cx+int(r*0.7),cy+int(r*0.7)),(s*4//5,s*4//5)], fill=c, width=w)

def i_heart(d,s,c):
    w=max(2,s//20)
    d.ellipse([(s//6,s//4),(s//2,s*3//5)], outline=c, width=w)
    d.ellipse([(s//2,s//4),(s*5//6,s*3//5)], outline=c, width=w)
    d.polygon([(s//6+2,s//2),(s//2,s*4//5),(s*5//6-2,s//2)], outline=c, width=w)

def i_heart_f(d,s,c):
    c2=h2r('#e74c3c')
    d.ellipse([(s//6,s//4),(s//2,s*3//5)], fill=c2)
    d.ellipse([(s//2,s//4),(s*5//6,s*3//5)], fill=c2)
    d.polygon([(s//6+2,s//2),(s//2,s*4//5),(s*5//6-2,s//2)], fill=c2)

def i_comment(d,s,c):
    w=max(2,s//20)
    d.rounded_rectangle([(s//6,s//5),(s*5//6,s*3//5)], radius=s//10, outline=c, width=w)
    d.polygon([(s//3,s*3//5),(s*2//5,s*3//4),(s//2,s*3//5)], fill=c)

def i_share(d,s,c):
    cx=s//2
    d.polygon([(cx,s//6),(s*3//4,s//2),(cx,s//2)], fill=c)
    d.polygon([(cx,s//6),(s//4,s//2),(cx,s//2)], fill=c)
    d.rectangle([(cx-s//16,s//2),(cx+s//16,s*3//4)], fill=c)

def i_camera(d,s,c):
    w=max(2,s//20)
    d.rounded_rectangle([(s//8,s//3),(s*7//8,s*3//4)], radius=s//16, outline=c, width=w)
    d.ellipse([(s*3//8,s*3//8),(s*5//8,s*5//8+s//8)], outline=c, width=w)
    d.rectangle([(s*3//8,s//4),(s*5//8,s//3+2)], fill=c)

def i_send(d,s,c):
    d.polygon([(s//5,s//4),(s*4//5,s//2),(s//5,s*3//4),(s//3,s//2)], fill=(255,255,255,255))

def i_emoji(d,s,c):
    w=max(2,s//20); r=s//3; cx=s//2; cy=s//2
    d.ellipse([(cx-r,cy-r),(cx+r,cy+r)], outline=c, width=w)
    er=max(2,s//20)
    d.ellipse([(cx-r//2-er,cy-r//4-er),(cx-r//2+er,cy-r//4+er)], fill=c)
    d.ellipse([(cx+r//2-er,cy-r//4-er),(cx+r//2+er,cy-r//4+er)], fill=c)
    d.arc([(cx-r//2,cy-r//8),(cx+r//2,cy+r//2)], 20, 160, fill=c, width=w)

def i_image(d,s,c):
    w=max(2,s//20)
    d.rounded_rectangle([(s//6,s//5),(s*5//6,s*4//5)], radius=s//12, outline=c, width=w)
    d.polygon([(s//4,s*2//3),(s*3//8,s//2),(s//2,s*2//3)], fill=c)
    d.polygon([(s//2,s*2//3),(s*5//8,s*5//12),(s*3//4,s*2//3)], fill=c)

def i_thumbup(d,s,c):
    w=max(2,s//20)
    d.rounded_rectangle([(s//6,s*5//12),(s*3//8,s*3//4)], radius=s//20, fill=c)
    d.rounded_rectangle([(s*3//8,s//4),(s*3//4,s*2//3)], radius=s//12, outline=c, width=w)

def i_report(d,s,c):
    w=max(2,s//20); t=max(2,s//20); cx=s//2
    d.ellipse([(s//4,s//6),(s*3//4,s*2//3)], outline=c, width=w)
    d.rectangle([(cx-t,s//3),(cx+t,s//2+2)], fill=c)
    d.ellipse([(cx-t-1,s//2+s//10),(cx+t+1,s//2+s//10+t*2+1)], fill=c)

def i_verified(d,s,c):
    c2=h2r(PRIMARY)
    d.ellipse([(s//4,s//4),(s*3//4,s*3//4)], fill=c2)
    w=max(2,s//16)
    d.line([(s*3//8,s//2),(s*7//16,s*5//8)], fill=(255,255,255), width=w)
    d.line([(s*7//16,s*5//8),(s*5//8,s*3//8)], fill=(255,255,255), width=w)

def i_edit(d,s,c):
    c2=h2r(PRIMARY); w=max(2,s//16)
    d.line([(s//4,s*3//4),(s*3//4,s//4)], fill=c2, width=w)
    d.line([(s//4,s*3//4),(s//4+s//8,s*3//4)], fill=c2, width=w)

def i_category(d,s,c):
    c2=h2r(TERTIARY); g=s//8; bs=(s-g*4)//2
    for r in range(2):
        for co in range(2):
            x=g+co*(bs+g); y=g+r*(bs+g)+s//8
            d.rounded_rectangle([(x,y),(x+bs,y+bs)], radius=max(2,bs//6), fill=c2)

def i_service(d,s,c):
    c2=h2r(SECONDARY); cx=s//2; cy=s*2//5; w=max(2,s//16)
    d.ellipse([(cx-s//4,cy-s//6),(cx+s//4,cy+s//6)], outline=c2, width=w)
    d.arc([(cx-s//3,cy-s//4),(cx+s//3,cy+s//4)], 200, 340, fill=c2, width=w)
    d.ellipse([(cx-s//16,s*3//4-s//16),(cx+s//16,s*3//4+s//16)], fill=c2)

def i_logout(d,s,c):
    c2=h2r(OUTLINE); w=max(2,s//16); cx=s//2
    d.arc([(s//4,s//4),(s*3//4,s*3//4)], 60, 300, fill=c2, width=w)
    d.polygon([(cx,s//6),(cx+s//6,s//3),(cx-s//6,s//3)], fill=c2)

def i_arrow(d,s,c):
    c2=h2r(OUTLINE); w=max(2,s//16); cx=s//2; cy=s//2; a=s//4
    d.line([(cx-a//2,cy-a),(cx+a//2,cy)], fill=c2, width=w)
    d.line([(cx+a//2,cy),(cx-a//2,cy+a)], fill=c2, width=w)

def i_treehole(d,s,c):
    c2=h2r(TERTIARY)
    d.ellipse([(s//5,s//4),(s*4//5,s*3//4)], fill=c2)
    d.ellipse([(s//3,s//3+4),(s*2//3,s*2//3-4)], fill=(255,255,255,200))

def i_megaphone(d,s,c):
    c2=h2r(SECONDARY)
    d.polygon([(s//4,s*3//8),(s*3//4,s//5),(s*3//4,s*4//5),(s//4,s*5//8)], fill=c2)
    d.rectangle([(s//6,s*3//8),(s//4+2,s*5//8)], fill=c2)

def i_location(d,s,c):
    c2=h2r(SECONDARY); cx=s//2; w=max(2,s//16)
    d.ellipse([(cx-s//5,s//5),(cx+s//5,s//5+s*2//5)], outline=c2, width=w)
    d.polygon([(cx-s//5,s//2-4),(cx,s*4//5),(cx+s//5,s//2-4)], fill=c2)
    d.ellipse([(cx-s//10,s//3),(cx+s//10,s//3+s//5)], fill=(255,255,255,200))

def i_anonymous(d,s,c):
    c2=h2r(TERTIARY); cx=s//2; cy=s*2//5; w=max(2,s//16)
    d.ellipse([(cx-s//4,cy-s//5),(cx+s//4,cy+s//5)], outline=c2, width=w)
    d.rectangle([(cx-s//3,cy-s//14),(cx+s//3,cy+s//14)], fill=c2)

def i_draft(d,s,c):
    w=max(2,s//20)
    d.rounded_rectangle([(s//4,s//6),(s*3//4,s*5//6)], radius=s//16, outline=c, width=w)
    for i in range(3):
        y=s//3+i*s//6
        d.line([(s//3,y),(s*2//3,y)], fill=c, width=max(1,s//32))

def i_settings(d,s,c):
    cx=s//2; cy=s//2; w=max(2,s//20)
    d.ellipse([(cx-s//6,cy-s//6),(cx+s//6,cy+s//6)], outline=c, width=w)
    for a in range(0,360,45):
        r=math.radians(a)
        x1=cx+int((s//5)*math.cos(r)); y1=cy+int((s//5)*math.sin(r))
        x2=cx+int((s//3)*math.cos(r)); y2=cy+int((s//3)*math.sin(r))
        d.line([(x1,y1),(x2,y2)], fill=c, width=w)

icons = {
    'icon_search': i_search, 'icon_heart': i_heart, 'icon_heart_filled': i_heart_f,
    'icon_comment': i_comment, 'icon_share': i_share, 'icon_camera': i_camera,
    'icon_send': i_send, 'icon_emoji': i_emoji, 'icon_image': i_image,
    'icon_thumbup': i_thumbup, 'icon_report': i_report, 'icon_verified': i_verified,
    'icon_edit': i_edit, 'icon_category': i_category, 'icon_service': i_service,
    'icon_logout': i_logout, 'icon_arrow': i_arrow, 'icon_treehole': i_treehole,
    'icon_megaphone': i_megaphone, 'icon_location': i_location,
    'icon_anonymous': i_anonymous, 'icon_draft': i_draft, 'icon_settings': i_settings,
}
for n, f in icons.items():
    ui(n, f)

# === 分类图标 64x64 ===
cats = [
    ('cat_team', PRIMARY_CONTAINER, PRIMARY),
    ('cat_trade', WHITE, SECONDARY),
    ('cat_treehole', TERTIARY_CONTAINER, TERTIARY),
    ('cat_campus', WHITE, PRIMARY),
    ('cat_study', WHITE, PRIMARY),
    ('cat_emotion', WHITE, '#e74c3c'),
    ('cat_help', WHITE, SECONDARY),
    ('cat_job', WHITE, ON_SURFACE),
]
for name, bg, fg in cats:
    img = Image.new('RGBA', (64,64), h2r(bg)+(255,))
    d = ImageDraw.Draw(img)
    c = h2r(fg); cx=32; cy=32
    if 'team' in name:
        d.ellipse([(cx-6,cy-14),(cx+6,cy-2)], fill=c)
        d.chord([(cx-18,cy+2),(cx+18,cy+22)], 0, 180, fill=c)
    elif 'trade' in name:
        d.rounded_rectangle([(cx-14,cy-8),(cx+14,cy+14)], radius=4, outline=c, width=3)
        d.arc([(cx-8,cy-16),(cx+8,cy)], 180, 360, fill=c, width=3)
    elif 'treehole' in name:
        d.ellipse([(cx-14,cy-10),(cx+14,cy+14)], fill=c)
        d.ellipse([(cx-6,cy-2),(cx+6,cy+8)], fill=h2r(bg))
    elif 'campus' in name:
        d.polygon([(cx,cy-16),(cx-16,cy),(cx+16,cy)], fill=c)
        d.rectangle([(cx-12,cy),(cx+12,cy+12)], fill=c)
    elif 'study' in name:
        for i in range(3):
            x=cx-10+i*6
            d.rounded_rectangle([(x,cy-12),(x+8,cy+12)], radius=2, fill=c)
    elif 'emotion' in name:
        d.ellipse([(cx-5,cy-14),(cx-1,cy-4)], fill=c)
        d.ellipse([(cx+1,cy-14),(cx+5,cy-4)], fill=c)
        d.polygon([(cx-7,cy-2),(cx+7,cy-2),(cx,cy+14)], fill=c)
    elif 'help' in name:
        d.ellipse([(cx-12,cy-14),(cx+12,cy+8)], outline=c, width=3)
        d.rectangle([(cx-2,cy+10),(cx+2,cy+14)], fill=c)
    elif 'job' in name:
        d.rounded_rectangle([(cx-14,cy-8),(cx+14,cy+12)], radius=3, fill=c)
        d.rectangle([(cx-6,cy-14),(cx+6,cy-8)], outline=c, width=2)
    save(name, img)

# === 头像 200x200 ===
avs = [
    ('avatar_1', '#e8b4b8', '#a855f7'),
    ('avatar_2', '#93c5fd', '#3b82f6'),
    ('avatar_3', '#86efac', '#22c55e'),
    ('avatar_default', '#d8e3f8', '#426089'),
]
for name, c1, c2 in avs:
    s = 200
    img = Image.new('RGBA', (s,s), (0,0,0,0))
    d = ImageDraw.Draw(img)
    r1, r2 = h2r(c1), h2r(c2)
    for y in range(s):
        t=y/s
        d.line([(0,y),(s,y)], fill=(int(r1[0]*(1-t)+r2[0]*t), int(r1[1]*(1-t)+r2[1]*t), int(r1[2]*(1-t)+r2[2]*t)))
    mask = Image.new('L', (s,s), 0)
    ImageDraw.Draw(mask).ellipse([(0,0),(s,s)], fill=255)
    img.putalpha(mask)
    d = ImageDraw.Draw(img)
    cx=s//2; hr=s//7
    d.ellipse([(cx-hr,cy-s//5-hr),(cx+hr,cy-s//5+hr)], fill=(255,255,255,200))
    d.chord([(cx-s//4,cy-s//16),(cx+s//4,cy+s//3)], 0, 180, fill=(255,255,255,200))
    save(name, img)

# === 内容图片 ===
# 横幅 750x320
img = Image.new('RGB', (750,320), h2r('#2c4a6e'))
d = ImageDraw.Draw(img)
for y in range(160):
    t=y/160; d.line([(0,y),(750,y)], fill=(int(60+140*t),int(80+120*t),int(140+80*t)))
for x in range(0,750,80):
    h=80+(x*37%120)
    d.rectangle([(x+5,320-h),(x+70,320)], fill=h2r('#1a365d'))
    for wy in range(320-h+10,310,20):
        for wx in range(x+12,x+65,18):
            d.rectangle([(wx,wy),(wx+10,wy+12)], fill=(255,220,120))
save('banner_library', img)

# 代码图 600x400
img = Image.new('RGB', (600,400), h2r('#1e293b'))
d = ImageDraw.Draw(img)
cc = ['#7dd3fc','#c4b5fd','#86efac','#fbbf24','#f9a8d4','#93c5fd']
for i in range(20):
    y=20+i*18; ind=(i%4)*20; l=80+(i*47)%200
    d.rounded_rectangle([(20+ind,y),(20+ind+l,y+10)], radius=2, fill=h2r(cc[i%len(cc)]))
save('post_code', img)

# 书本图 600x400
img = Image.new('RGB', (600,400), h2r('#fef3c7'))
d = ImageDraw.Draw(img)
for y in range(400):
    t=(y*13%40)/40; c=int(210+20*t)
    d.line([(0,y),(600,y)], fill=(c,int(c*0.85),int(c*0.6)))
d.rounded_rectangle([(150,80),(450,320)], radius=8, fill=h2r('#1e3a5f'))
d.rounded_rectangle([(155,85),(445,315)], radius=6, fill=h2r('#2c5282'))
d.rectangle([(148,80),(155,320)], fill=h2r('#e2e8f0'))
for i in range(5):
    d.line([(190,130+i*30),(410,130+i*30)], fill=(200,200,200), width=2)
save('post_book', img)

print('Done! All icons and images generated.')
files = sorted(os.listdir(OUT))
print(f'Total: {len(files)} files')
for f in files:
    sz = os.path.getsize(os.path.join(OUT, f))
    print(f'  {f} ({sz}B)')
