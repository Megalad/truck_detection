import json
with open('camera.json', 'r') as f:
    data = json.load(f)

cameras_to_find = [
    "TV73R M7-64+872-IPT",
    "TV84L M9-63+000-WSL",
    "TV15L M7-10+000-TC"
]

for cam in data['data']['cctv']:
    if cam['title'] in cameras_to_find:
        print(f"Title: {cam['title']}\nURL: {cam['url']}\n")
