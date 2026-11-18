"""WorldSnapshot 2.0 JSON Schema 내보내기.

    py -m worldmodel.contract.export            → worldmodel/contract/json/WorldSnapshot_2_0.schema.json

Device.state는 kind에 따라 모양이 다르다. Pydantic 모델에선 kind를 보고 검증하지만 JSON Schema에서는
6가지 state 중 하나(oneOf)로 적고, kind와의 짝은 if/then으로 묶는다.
ID 참조·중복·온도 간격 등은 Schema로 표현하지 못하므로 semantic.check()를 함께 써야 한다.
"""

from __future__ import annotations

import json
from pathlib import Path

from worldmodel.contract.models import STATE_BY_KIND, WorldSnapshot

OUT = Path(__file__).parent / "json" / "WorldSnapshot_2_0.schema.json"


def schema() -> dict:
    s = WorldSnapshot.model_json_schema(mode="validation")
    defs = s.setdefault("$defs", {})
    for kind, model in STATE_BY_KIND.items():
        sub = model.model_json_schema(ref_template="#/$defs/{model}")
        defs.update(sub.pop("$defs", {}))
        defs[model.__name__] = sub
    dev = defs["Device"]
    dev["properties"]["state"] = {
        "oneOf": [{"$ref": f"#/$defs/{m.__name__}"} for m in STATE_BY_KIND.values()],
        "description": "kind에 맞는 state. allOf의 if/then으로 짝을 고정한다.",
    }
    dev["allOf"] = [
        {"if": {"properties": {"kind": {"const": k}}},
         "then": {"properties": {"state": {"$ref": f"#/$defs/{m.__name__}"}}}}
        for k, m in STATE_BY_KIND.items()
    ]
    s["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    s["$id"] = "https://github.com/HY-LG-EYEAR/eyear-worldmodel/WorldSnapshot_2_0.schema.json"
    s["title"] = "WorldSnapshot 2.0"
    return s


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(schema(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(OUT)


if __name__ == "__main__":
    main()
