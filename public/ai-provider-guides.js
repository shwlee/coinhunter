// Instructions are data so provider console changes do not require wizard changes.
// OpenAI billing guidance checked 2026-10-14; menu labels may vary by account/language.
export const AI_PROVIDER_GUIDES = {
  openai: {
    name: 'OpenAI',
    consoleUrl: 'https://platform.openai.com/api-keys',
    documentationUrl: 'https://developers.openai.com/api/docs/quickstart',
    billingUrl: 'https://platform.openai.com/settings/organization/billing/overview',
    preparation: '결제에 사용한 조직·프로젝트에서 API 키를 발급하세요.',
    steps: [
      '「키 발급 화면 열기」를 눌러 OpenAI API 플랫폼에 로그인하세요.',
      'API keys에서 사용할 프로젝트를 고르고 Create new secret key를 누르세요.',
      '키 이름은 coin-hunter처럼 알아보기 쉽게 입력하세요.',
      '발급된 비밀 키 전체를 복사하세요. 키 이름·프로젝트 ID는 사용할 수 없습니다.',
      '이 창으로 돌아와 「API 키 입력으로」를 눌러 붙여 넣으세요.',
    ],
    trouble:
      '키 생성 메뉴가 없으면 프로젝트와 계정 권한을 확인하세요. 모델 조회 권한이 제한된 키는 확인에 실패할 수 있습니다. 키 원문을 다시 볼 수 없다면 새 키를 발급하세요.',
  },
  anthropic: {
    name: 'Claude',
    consoleUrl: 'https://platform.claude.com/settings/keys',
    documentationUrl: 'https://platform.claude.com/docs/en/get-api-key',
    billingUrl: 'https://platform.claude.com/settings/billing',
    preparation:
      'Claude Console에 로그인하거나 가입합니다. Claude 채팅 화면이 아닌 API Console에서 키를 발급합니다. Console의 API 크레딧·결제 상태도 확인하세요.',
    steps: [
      '「키 발급 화면 열기」를 눌러 Claude Console에 로그인하세요.',
      'Settings → API keys로 이동하여 Create key를 선택하세요.',
      '키 이름에 coin-hunter 등을 입력하세요. 만료 기간을 고르고 Linked account에서 본인 계정을 선택하세요. Workspace 항목이 있으면 사용할 작업 공간을 고르세요.',
      '생성된 API 키 전체를 복사하세요. 키 이름이나 Workspace ID를 복사하는 것이 아닙니다.',
      '이 창으로 돌아와 「키를 준비했어요」를 누르세요. 다음 화면에서 붙여 넣고 확인합니다.',
    ],
    trouble:
      '키 생성 버튼이 없으면 Console의 작업 공간과 권한을 확인하세요. 모델 조회가 성공해도 실제 생성에는 사용 가능한 API 크레딧과 모델 권한이 필요할 수 있습니다.',
  },
  gemini: {
    name: 'Gemini',
    consoleUrl: 'https://aistudio.google.com/apikey',
    documentationUrl: 'https://ai.google.dev/gemini-api/docs/api-key',
    billingUrl: 'https://ai.google.dev/gemini-api/docs/billing',
    preparation:
      'Google AI Studio에 로그인합니다. 최초 이용 시 약관 확인과 프로젝트 준비가 필요할 수 있습니다. 무료·유료 이용 가능 범위와 한도는 프로젝트·모델별로 확인하세요.',
    steps: [
      '「키 발급 화면 열기」를 눌러 Google AI Studio에 Google 계정으로 로그인하세요.',
      'API Keys 화면에서 키 목록을 확인하세요. 처음 이용하면 기본 프로젝트와 키가 준비되어 있을 수 있습니다.',
      '새 키가 필요하면 Create API key를 선택하세요. 프로젝트를 요구하면 사용할 프로젝트를 선택하거나 준비하세요.',
      '기존 프로젝트가 목록에 없으면 Dashboard → Projects에서 Import projects로 가져온 뒤 API Keys로 돌아오세요.',
      'API 키 전체를 복사하고 이 창으로 돌아와 「키를 준비했어요」를 누르세요. 프로젝트 번호나 OAuth 클라이언트 값을 입력하지 마세요.',
    ],
    trouble:
      'Create API key가 비활성화되면 프로젝트의 키 생성 권한을 확인하세요. 회사 계정은 조직 정책으로 발급이 제한될 수 있으므로 관리자에게 문의하세요. 차단·제한된 키는 공식 안내에 따라 확인하세요.',
  },
};

export const AI_CONNECTION_ERROR_HELP = {
  credential_invalid:
    '키 원문 전체와 제공자가 일치하는지 확인하세요. 키 이름·프로젝트 ID·OAuth 클라이언트 ID는 사용할 수 없습니다. 키의 모델 조회 권한도 확인하세요.',
  network_error:
    '게임 서버에서 제공자에 접속하지 못했습니다. 키를 다시 발급하기 전에 운영자에게 외부 연결 가능 여부를 문의하세요.',
  timeout:
    '제공자 응답이 지연됐습니다. 잠시 후 다시 확인하고, 반복되면 운영자에게 서버의 외부 연결을 확인해 달라고 요청하세요.',
  rate_limited:
    '짧은 시간에 확인 요청이 많거나 제공자의 이용 한도에 도달했습니다. 잠시 기다린 뒤 다시 시도하세요.',
  quota_exceeded:
    'OpenAI API 결제 설정에서 크레딧 잔액과 사용 한도를 확인하세요. ChatGPT 구독료와 별개입니다.',
  credit_exhausted:
    'API 결제 설정에서 크레딧을 구매하거나 충전하세요. 기존 ChatGPT 구독만으로는 API 잔액이 생기지 않습니다.',
  spend_limit_exceeded: 'API 결제 조직·프로젝트의 지출 한도 설정을 확인하세요.',
  usage_limit_exceeded: 'OpenAI API 조직의 사용 한도를 확인하세요.',
  provider_rate_limited:
    '선택한 모델의 요청·토큰 한도 문제입니다. 잠시 후 다시 시도하거나 요청 길이를 줄이세요.',
  provider_limit_unknown:
    'OpenAI API 결제 잔액과 이용 한도를 확인하세요. API 키 재발급만으로 해결되지 않을 수 있습니다.',
  model_unavailable: '목록을 새로고침한 뒤 현재 연결에서 제공되는 모델을 다시 선택하세요.',
  revision_conflict:
    '다른 작업에서 연결이 변경됐습니다. 연결 관리 화면을 다시 열어 최신 상태를 확인하세요.',
  unauthenticated: '로그인 세션을 확인한 뒤 다시 로그인하세요.',
  invalid_input:
    '입력 항목을 확인하세요. API 키 앞뒤의 공백이나 줄바꿈은 제거하고 키 원문만 입력하세요.',
};
