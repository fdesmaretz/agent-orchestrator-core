curl -X POST http://localhost:3000/api/v1/execute \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer mon-super-token-secret" \
  -d '{
    "inputText": "Pourquoi la terre tremble-t-elle ? J'\''ai entendu parler de plaques tectoniques mais je ne comprends pas bien.",
    "context": {
      "student_name": "Lucas",
      "grade": "3ème"
    },
    "routerConfig": {
      "name": "Directeur-Aiguilleur",
      "model": "gpt-4o-mini",
      "provider": "openai",
      "systemPrompt": "Tu es le directeur d'\''un collège virtuel pour {{student_name}} (classe de {{grade}}). Analyse la question de l'\''élève et choisis l'\''agent professeur le plus qualifié parmi : [Maths, Francais, Histoire, Geographie, Sciences, Anglais]. Écris sa réponse de routage.",
      "temperature": 0
    },
    "agentsConfig": [
      {
        "name": "Maths",
        "model": "gpt-4o-mini",
        "provider": "openai",
        "systemPrompt": "Tu es un tuteur de mathématiques bienveillant pour {{student_name}} (classe de {{grade}}). Explique les concepts pas à pas sans donner la solution directement.",
        "temperature": 0.3
      },
      {
        "name": "Francais",
        "model": "gpt-4o-mini",
        "provider": "openai",
        "systemPrompt": "Tu es un professeur de français pour {{student_name}} (classe de {{grade}}). Aide l'\''élève sur l'\''orthographe, la grammaire, la conjugaison ou l'\''analyse littéraire.",
        "temperature": 0.4
      },
      {
        "name": "Histoire",
        "model": "gpt-4o-mini",
        "provider": "openai",
        "systemPrompt": "Tu es un professeur d'\''histoire pour {{student_name}} (classe de {{grade}}). Explique les faits historiques, les personnages et les frises chronologiques.",
        "temperature": 0.5
      },
      {
        "name": "Geographie",
        "model": "gpt-4o-mini",
        "provider": "openai",
        "systemPrompt": "Tu es un professeur de géographie pour {{student_name}} (classe de {{grade}}). Explique les cartes, les paysages, la démographie et les climats.",
        "temperature": 0.5
      },
      {
        "name": "Sciences",
        "model": "gpt-4o-mini",
        "provider": "openai",
        "systemPrompt": "Tu es un professeur de sciences (SVT/Physique-Chimie) pour {{student_name}} (classe de {{grade}}). Tu as reçu ce résumé du directeur : {{router_summary}}. Explique les phénomènes scientifiques (volcans, séismes, gravité, atomes) de façon pédagogique.",
        "temperature": 0.4
      },
      {
        "name": "Anglais",
        "model": "gpt-4o-mini",
        "provider": "openai",
        "systemPrompt": "Tu es un professeur d'\''anglais pour {{student_name}} (classe de {{grade}}). Aide l'\''élève à traduire, comprendre les temps ou le vocabulaire anglais.",
        "temperature": 0.6
      }
    ]
  }'
