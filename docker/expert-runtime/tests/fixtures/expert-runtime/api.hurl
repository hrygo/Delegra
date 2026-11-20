GET {{base}}/api
HTTP 200
[Asserts]
jsonpath "$.ok" == true

GET {{base}}/missing
HTTP 404
[Asserts]
jsonpath "$.ok" == false
