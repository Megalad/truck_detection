import json

# JSON ဖိုင်ကို ဖတ်မည်
with open('camera.json', 'r', encoding='utf-8') as file:
    response_data = json.load(file)

# 'data' ထဲက 'cctv' စာရင်းကို ဆွဲထုတ်မည်
cctv_list = response_data['data']['cctv']
camera_urls = {}

for cam in cctv_list:
    cam_name = cam.get('title')
    original_url = cam.get('url')
    
    if cam_name and original_url:
        # AI အတွက် ပိုကောင်းစေရန် URL ထဲမှ _720p ကို ဖြုတ်၍ Master Stream ပြောင်းမည်
        master_url = original_url.replace('_720p', '')
        camera_urls[cam_name] = master_url

print(f"စုစုပေါင်း ကင်မရာ အရေအတွက်: {len(camera_urls)} လုံး ရရှိပါသည်\n")

# နမူနာအဖြစ် ပထမဆုံး ကင်မရာ ၅ လုံးကို စမ်းသပ်ထုတ်ကြည့်မည်
for name, url in list(camera_urls.items())[:5]:
    print(f"{name}: {url}")