#!/usr/bin/env python3
"""PaddleOCR wrapper - takes image path, outputs recognized text lines to stdout."""
import sys
import json
import os
import warnings
warnings.filterwarnings("ignore")
os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"

from paddleocr import PaddleOCR

ocr = PaddleOCR(lang='en')

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: paddle_ocr.py <image_path>"}))
        sys.exit(1)

    image_path = sys.argv[1]
    if not os.path.exists(image_path):
        print(json.dumps({"error": f"File not found: {image_path}"}))
        sys.exit(1)

    try:
        results = ocr.predict(image_path)
    except Exception as e:
        print(json.dumps({"error": f"OCR prediction failed: {str(e)}"}))
        sys.exit(1)

    if not results:
        sys.exit(0)

    r = results[0]
    texts = r.json if isinstance(r.json, dict) else json.loads(str(r.json))
    rec_texts = texts.get("rec_texts", [])
    for text in rec_texts:
        print(text)

if __name__ == "__main__":
    main()
