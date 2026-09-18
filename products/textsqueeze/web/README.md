# textsqueeze web demo

브라우저에서 설치 없이 textsqueeze를 체험할 수 있는 단일 정적 페이지입니다.

## 사용법

로컬에서 열어보기:

```bash
cd textsqueeze/web
python3 -m http.server 8080
# 브라우저에서 http://localhost:8080 접속
```

또는 `index.html`을 브라우저로 더블클릭해서 바로 열어도 동작합니다
(외부 리소스나 서버가 필요 없음).

## 동작 방식

- `textsqueeze-core.js`는 `src/index.js`, `src/json-squeeze.js`와 동일한
  로직을 브라우저에서 그대로 쓸 수 있게 옮긴 순수 자바스크립트 파일입니다
  (Node의 `module.exports` 대신 `window.TextSqueeze`에 노출).
- 텍스트를 붙여넣고 "줄이기" 버튼을 누르면 `TextSqueeze.squeeze()` 또는
  `TextSqueeze.squeezeJson()`이 브라우저 안에서 즉시 실행됩니다.
- **네트워크 요청이 전혀 없습니다.** 입력한 내용은 서버로 전송되지 않고,
  로컬 저장소에도 저장되지 않습니다. 탭을 닫으면 사라집니다.
- 토큰 수는 "글자 수 ÷ 4" 근사치이며, 실제 LLM 토크나이저와는 차이가
  있을 수 있습니다. 페이지에도 이 사실과 "중요 내용이 삭제될 수 있다"는
  경고를 명시했습니다.

## 검증

- Node 환경에서 `window` 객체를 shim하여 `textsqueeze-core.js`의
  `squeeze`/`squeezeJson` 함수가 CLI 버전(`src/index.js`,
  `src/json-squeeze.js`)과 동일한 출력을 내는지 확인함 (반복 줄 압축,
  배열 edge-keeping, 우선순위 키 보존 모두 정상 동작 확인).
- 결제 버튼, 가짜 사용자 수/후기, 유료 기능 없음 — 순수 무료 데모.
