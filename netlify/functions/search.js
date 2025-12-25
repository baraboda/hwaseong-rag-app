const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { query, excludeIds = [] } = JSON.parse(event.body);
    const cleanQuery = query.trim();

    // 1. 키워드 검색 (ILIKE)
    let keywordDocs = [];

    const { data: exactMatches } = await supabase
      .from('documents')
      .select('id, content, metadata')
      .ilike('content', `%${cleanQuery}%`)
      .limit(20);

    if (exactMatches && exactMatches.length > 0) {
      keywordDocs = exactMatches;
    } else {
      const words = cleanQuery.split(/\s+/).filter(w => w.length >= 2);

      if (words.length > 0) {
        const { data: looseMatches } = await supabase
          .from('documents')
          .select('id, content, metadata')
          .ilike('content', `%${words[0]}%`)
          .limit(30);

        if (looseMatches) {
          keywordDocs = looseMatches.filter(doc => {
            return words.slice(1).every(w => doc.content.includes(w));
          });
          
          if (keywordDocs.length === 0) {
            keywordDocs = looseMatches;
          }
        }
      }
    }

    // 2. 벡터 검색
    const embeddingResponse = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        input: cleanQuery,
        model: 'text-embedding-3-small'
      })
    });

    const embeddingData = await embeddingResponse.json();
    const queryEmbedding = embeddingData.data[0].embedding;

    const { data: vectorDocs } = await supabase.rpc('match_documents', {
      query_embedding: queryEmbedding,
      match_count: 20
    });

    // 3. 결과 합치기 (excludeIds 제외)
    const excludeSet = new Set(excludeIds);
    const seenIds = new Set();
    const combinedDocs = [];
    
    for (const doc of keywordDocs) {
      if (!seenIds.has(doc.id) && !excludeSet.has(doc.id)) {
        seenIds.add(doc.id);
        combinedDocs.push(doc);
      }
    }

    if (vectorDocs) {
      for (const doc of vectorDocs) {
        if (!seenIds.has(doc.id) && !excludeSet.has(doc.id)) {
          seenIds.add(doc.id);
          combinedDocs.push(doc);
        }
      }
    }

    // 4. 첫 번째 문서만 선택
    const currentDoc = combinedDocs[0];
    const hasMore = combinedDocs.length > 1;

    if (!currentDoc) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          answer: '더 이상 관련 기록이 없습니다.',
          sources: [],
          hasMore: false,
          currentId: null
        })
      };
    }

    // 5. Context 구성 (현재 문서 1개만)
    const m = currentDoc.metadata || {};
    const context = `[문서]
- 유형: ${m.meeting_type || '미상'}
- 날짜: ${m.date || '미상'}
- 내용: ${currentDoc.content}`;

    // 6. Claude 요청
    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: `당신은 국무회의/차관회의/업무보고 기록을 분석하는 '전문가 자문단'입니다.

검색어: "${cleanQuery}"

[검색된 문서]:
"""
${context}
"""

[전문가 페르소나]
1. 시민소통 전문가: 복잡한 행정 이슈를 초등학생도 이해할 수 있게 쉬운 일상어로 풀어 설명. "이게 왜 내 삶에 중요한가?"를 명확히 전달.
2. 정책분석가: 해당 쟁점의 전국적/세계적 트렌드, 타 지자체 사례, 관련 통계를 바탕으로 객관적 평가.
3. 선거전략가: 이 쟁점이 정치적으로 어떤 의미를 갖는지, 유권자 반응 예측 분석.

[답변 가이드]
1. 이 문서에서 검색어와 관련된 내용을 찾아 설명하세요.
2. 검색어와 관련 없으면 "이 문서에는 관련 내용이 없습니다"라고 답변.

[분석 프로세스]
1단계: 관련 내용 정리
2단계: 시민소통 전문가 관점 - 쉬운 설명
3단계: 정책분석가 관점 - 국가적 맥락, 트렌드
4단계: 선거전략가 관점 - 정치적 함의
5단계: 종합 정리`
        }]
      })
    });

    const claudeData = await claudeResponse.json();
    const answer = claudeData.content[0].text;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        answer,
        sources: [currentDoc.metadata],
        hasMore,
        currentId: currentDoc.id
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
