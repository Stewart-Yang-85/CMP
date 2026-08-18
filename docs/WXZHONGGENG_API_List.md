# WXZHONGGENG API 接口清单

## 0. 通用说明

- Base URL: `https://connect.expeditioniot.com/`
- Auth: 所有请求 Header 需包含 `token: <token>`，通过获取 Token 接口获得，并返回超期时间
- 时区: 系统时间为 GMT+0，应答时间均基于此时区

### 0.1 运营商标识

| 运营商标识 | 运营商名称 |
| :--- | :--- |
| `0` | DCP |
| `1` | CM |
| `2` | CT |
| `3` | CU |
| `4` | JS |
| `5` | TT |
| `6` | FL |
| `7` | TL |

### 0.2 接口状态码
#### 0.21 HTTP 状态码

| code | 描述 |
| :--- | :--- |
| `200` | 成功 |
| `201` | 成功 |
| `400` | 参数异常 |
| `401` | 未授权 |
| `403` | 禁止访问 |
| `500` | 服务器内部错误 |

### 0.3 响应码
#### 0.31 code状态码

| 代码 | 描述 |
| :--- | :--- |
| `00000` | 请求成功 |
| `00001` | 请求失败，业务错误 |
| `A0000` | 用户名密码错误 |
| `A0003` | TOKEN错误 |
| `A0004` | TOKEN不存在或过期 |
| `P0000` | 参数校验不通过 |
| `P0001` | 参数不完整 |
| `P0002` | 参数类型错误 |
| `P0003` | 参数值错误 |
| `B0001` | 代表是异步调用了运营商，结果 运营商返回超时，这种情况大概率是成功。需要重新查询一次状态 |
| `B0002` | 代表跟原本状态一样，不能再次调用 |
| `B0003` | 修改失败 |
| `E0000` | 系统异常 |
| `E0001` | 业务异常 |
| `E0002` | SQL异常 |
| `E0003` | IO异常 |
| `T0000` | 第三方服务调用失败 |
| `T0001` | 第三方服务调用异常 |
| `T0002` | 第三方服务调用返回失败 |


### 0.4 SIM 卡状态（status）

| 状态值 | 说明 |
| :--- | :--- |
| NoActivty | 未激活 |
| Activty | 已激活 |
| Stop | 已停机 |
| PreCancel | 预销户 |
| Dismantle | 已销户 |

### 0.5 SIM卡状态 (state)
仅适用于运营商标识为5的情况
| 状态值 | 说明 |
| :--- | :--- |
| TestReady | 测试状态 |
| PreActive | 静默状态 |
| Active | 已激活 |
| Suspended | 停机 |
| Terminate | 销户 |


## 1. 认证接口
### 1.1 获取 Token（Get Token）

- Method/Path: `POST /sim-user-center/api/login`
- Headers: N/A
- Request Body
  - apiKey: string，必需
  - apiSecret: string，必需

示例请求：

```json
{
  "apiKey": "2c9f8662b928e068",
  "apiSecret": "d3369269ff814cda75fc4f1ff9576994"
}
```

- Response
  - code: string，执行返回码，必需
  - success: boolean，是否成功，必需
  - message: string，提示内容，必需
  - data: object，token 数据，必需
    - expireTime: string，过期时间，2个小时，必需
    - token: string，用于后续请求的 token（放在其他接口 header），必需

- Response示例：
{
    "code": "00000",
    "success": true,
    "message": "操作成功",
    "data": {
        "expireTime": "2026-06-16 14:17:43",
        "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJ1c2VySW5mbyI6IntcImFjY291bnRcIjpcIjJjOWY4NjYyYjkyOGUwNjhcIixcImN1c3RvbWVySWRcIjpcImU5YmIxNmJlOWFmY2JkYjZlYzQ0MmJlOTgwNDQ2ZWNjXCIsXCJjdXN0b21lckluZm9cIjp7XCJsZXZlbFwiOjEsXCJuYW1lXCI6XCLlhazlj7jmtYvor5XljaFcIixcInBhcmVudElkXCI6XCIxXCIsXCJ0eXBlXCI6XCJpbmR1c3RyeVwifSxcImlkXCI6XCJkMmRjOWI3MzhiMWMzYjQxMWNjNTkxOTgyNDY2OTRlNVwiLFwiaXNBZG1pblwiOmZhbHNlLFwicm9sZUlkXCI6XCIxXCIsXCJyb2xlSW5mb1wiOntcIm5hbWVcIjpcIuaOpeWPo-inkuiJslwifSxcInR5cGVcIjoxfSIsImV4cCI6MTc4MTYxOTQ2M30.bAIn8w-WbVLtAk6zHn6q5VRlPGYo-yPoOBXI49NQSfs"
    }
}

Notes: 获取 Token，是所有后续接口调用的基础。

## 2. 查询类接口
### 2.1 查询单个 SIM 卡信息（Query SIM Info）

- Method/Path: `POST /sim-card-sale/card/card-info/api/queryInfo`
- Headers
  - token: string，必需
- Request Body

| 参数名称 | 数据类型 | 参数描述 | 是否必需 |
| :--- | :--- | :--- | :--- |
| iccid | string | 指定 SIM 卡的 ICCID 号 | 是 |

示例请求：

```json
{
  "iccid": "893107032536642026"
}
```

- Response

| 参数名称 | 数据类型 | 参数描述 | 是否必需 |
| :--- | :--- | :--- | :--- |
| code | string | Code 状态码，参见通用信息 | 是 |
| success | boolean | 成功标识 | 是 |
| message | string | 消息 | 是 |
| data | object | 数据 | 是 |
| data.iccid | string | 运营商 ICCID | 是 |
| data.msisdn | string | 运营商 MSISDN | 是 |
| data.imsi | string | 运营商 IMSI | 是 |
| data.ispType | string | 运营商类型 | 是 |
| data.batchQuery | boolean | 是否建议批量查询 | 是 |
| data.batchUpdate | boolean | 是否建议批量修改状态 | 是 |
| data.qps | integer | 单位时间内调用 API 请求次数限定 | 是 |

响应示例：

```json
{
    "code": "00000",
    "success": true,
    "message": "操作成功",
    "data": {
        "iccid": "893107032536642026",
        "imsi": "204080936642026",
        "msisdn": "3197093469494",
        "ispType": "5",
        "batchQuery": true,
        "batchUpdate": true,
        "qps": 10
    }
}
```

Notes: 查询指定 SIM 卡的归属信息，返回 MSISDN、IMSI 以及批量查询/批量操作建议。

### 2.2 查询批量 SIM 卡信息（Query Bulk SIMs Info）

- Method/Path: `POST /sim-card-sale/card/card-info/api/simCard`
- Headers
  - token: string，必需
- Request Body

| 参数名称 | 数据类型 | 参数描述 | 是否必需 |
| :--- | :--- | :--- | :--- |
| iccids | array[string] | ICCID 列表 | 是 |

示例请求：

```json
{
  "iccids": ["893107032536642026", "893107032536642338", "893107032536643267"]
}
```

- Response

| 参数名称 | 数据类型 | 参数描述 | 是否必需 |
| :--- | :--- | :--- | :--- |
| code | string | Code 状态码，参见通用信息 | 是 |
| success | boolean | 成功标识 | 是 |
| message | string | 消息 | 是 |
| data | array[object] | 数据 | 是 |
| data[].iccid | string | 运营商 ICCID | 是 |
| data[].salePackageName | string | 订阅的产品包名称 | 是 |
| data[].salePackageCode | string | 订阅的产品包编码 | 是 |
| data[].imsi | string | 运营商 IMSI | 是 |
| data[].msisdn | string | 运营商 MSISDN | 是 |
| data[].sn | null | 虚拟号 | 是 |
| data[].status | string | SIM 卡状态 | 是 |
| data[].chargeTime | string | 计费开始时间 | 是 |
| data[].activateTime | string | SIM 卡激活时间 | 是 |
| data[].expireTime | string | SIM 卡到期时间 | 是 |
| data[].totalFlow | integer | 总数据流量配额，单位 KB | 是 |
| data[].usedFlow | integer | 已使用数据流量，单位 KB | 是 |
| data[].residualFlow | integer | 剩余流量配额，单位 KB | 是 |


响应示例：

```json
{
    "code": "00000",
    "success": true,
    "message": "操作成功",
    "data": [
        {
            "iccid": "893107032536642026",
            "salePackageName": "10G/月(测试TT)",
            "salePackageCode": "20230122112404",
            "imsi": "204080936642026",
            "msisdn": "3197093469494",
            "sn": null,
            "status": "Activty",
            "chargeTime": "2025-10-27 07:46:07",
            "activateTime": "2025-09-06 11:36:30",
            "expireTime": "2026-09-30 23:59:59",
            "totalFlow": 10485760,
            "usedFlow": 6523978,
            "residualFlow": 3961782
        },
        {
            "iccid": "893107032536642338",
            "salePackageName": "10G/月(测试TT)",
            "salePackageCode": "20230122112404",
            "imsi": "204080936642338",
            "msisdn": "3197092811824",
            "sn": null,
            "status": "Activty",
            "chargeTime": "2025-12-23 12:28:52",
            "activateTime": "2025-12-23 03:23:36",
            "expireTime": "2028-03-28 23:59:59",
            "totalFlow": 10485760,
            "usedFlow": 547,
            "residualFlow": 10485213
        },
        {
            "iccid": "893107032536643267",
            "salePackageName": "10G/月(测试TT)",
            "salePackageCode": "20230122112404",
            "imsi": "204080936643267",
            "msisdn": "3197093311157",
            "sn": null,
            "status": "Activty",
            "chargeTime": "2026-05-08 05:30:19",
            "activateTime": "2026-05-08 05:30:15",
            "expireTime": "2026-07-31 23:59:59",
            "totalFlow": 10485760,
            "usedFlow": 4504435,
            "residualFlow": 5981325
        }
    ]
}
```

Notes: 查询一批 SIM 卡的信息，返回 MSISDN、IMSI、计费开始时间、总流量配额与已用流量等。

### 2.3 批量同步 SIM 卡信息（Syn Bulk SIMs Info）
- 说明：本接口提供给客户分页查询所有SIM卡的数据，查询的是本系统定时同步后的数据，非运营商实时数据，若需要实时数据，请调用其他接口。

- Method/Path: `POST /sim-card-sale/card/card-info/api/simCardSync`
- Headers
  - token: string，必需
- Request Body

| 参数名称 | 数据类型 | 参数描述 | 是否必需 |
| :--- | :--- | :--- | :--- |
| pageSize | integer | 页数据大小，缺省值 50 | 是 |
| pageIndex | integer | 页码，缺省值 1 | 是 |
| status | string | 卡状态 | 否 |

status 取值：参见通用说明 SIM 卡状态（status）。

示例请求：

```json
{
  "pageSize": 3,
  "pageIndex": 1,
  "status": "Activty"
}
```

- Response

| 参数名称 | 数据类型 | 参数描述 | 是否必需 |
| :--- | :--- | :--- | :--- |
| code | string | Code 状态码，参见通用信息 | 是 |
| success | boolean | 成功标识 | 是 |
| message | string | 消息 | 是 |
| data | object | 数据 | 是 |
| data.pageIndex | integer | 页码 | 是 |
| data.pageSize | integer | 每页记录数 | 是 |
| data.totalCount | integer | 总行数 | 是 |
| data.iccids | array[object] | ICCID 列表 | 是 |
| data.iccids[].iccid | string | 运营商 ICCID | 是 |
| data[].salePackageName | string | 订阅的产品包名称 | 是 |
| data[].salePackageCode | string | 订阅的产品包编码 | 是 |
| data[].imsi | string | 运营商 IMSI | 是 |
| data[].msisdn | string | 运营商 MSISDN | 是 |
| data[].sn | null | 虚拟号 | 是 |
| data[].status | string | SIM 卡状态 | 是 |
| data[].chargeTime | string | 计费开始时间 | 是 |
| data[].activateTime | string | SIM 卡激活时间 | 是 |
| data[].expireTime | string | SIM 卡到期时间 | 是 |
| data[].totalFlow | integer | 总数据流量配额，单位 KB | 是 |
| data[].usedFlow | integer | 已使用数据流量，单位 KB | 是 |
| data[].residualFlow | integer | 剩余流量配额，单位 KB | 是 |

响应示例：

```json
{
    "code": "00000",
    "success": true,
    "message": "操作成功",
    "data": {
        "records": [
            {
                "pageIndex": 1,
                "pageSize": 3,
                "totalCount": null,
                "iccids": [
                    {
                        "iccid": "893107032536638540",
                        "salePackageName": null,
                        "salePackageCode": null,
                        "imsi": "204080936638540",
                        "msisdn": "3197093407905",
                        "sn": null,
                        "status": "Stop",
                        "chargeTime": "2025-05-14 08:40:27",
                        "activateTime": "2025-04-30 13:05:38",
                        "expireTime": "2026-04-30 23:59:59",
                        "totalFlow": 10485760,
                        "usedFlow": 0,
                        "residualFlow": 10485760
                    },
                    {
                        "iccid": "893107032536638542",
                        "salePackageName": null,
                        "salePackageCode": null,
                        "imsi": "204080936638542",
                        "msisdn": "3197093587962",
                        "sn": null,
                        "status": "Stop",
                        "chargeTime": "2025-05-14 10:44:33",
                        "activateTime": "2025-05-14 10:44:28",
                        "expireTime": "2025-08-14 10:44:33",
                        "totalFlow": 10485760,
                        "usedFlow": 0,
                        "residualFlow": 10485760
                    },
                    {
                        "iccid": "893107032536638543",
                        "salePackageName": null,
                        "salePackageCode": null,
                        "imsi": "204080936638543",
                        "msisdn": "3197093409581",
                        "sn": null,
                        "status": "Stop",
                        "chargeTime": "2025-05-16 09:47:06",
                        "activateTime": "2025-05-16 09:47:06",
                        "expireTime": "2025-08-16 09:47:06",
                        "totalFlow": 10485760,
                        "usedFlow": 0,
                        "residualFlow": 10485760
                    }
                ]
            }
        ],
        "total": 93,
        "size": 3,
        "current": 1,
        "orders": [],
        "optimizeCountSql": true,
        "searchCount": true,
        "countId": null,
        "maxLimit": null,
        "pages": 31
    }
}
```

Notes: 批量同步查询 SIM 卡信息，按分页返回 MSISDN、IMSI、计费开始时间、总流量配额与已用流量等。

### 2.4 查询单个 SIM 卡状态（Query SIM Status）

- Method/Path: `POST /sim-card-sale/card/card-info/api/queryCardStatus`
- Headers
  - token: string，必需
- Request Body

| 参数名称 | 数据类型 | 参数描述 | 是否必需 |
| :--- | :--- | :--- | :--- |
| iccid | string | ICCID | 是 |

示例请求：

```json
{
  "iccid": "893107032536642026"
}
```

- Response

| 参数名称 | 数据类型 | 参数描述 | 是否必需 |
| :--- | :--- | :--- | :--- |
| code | string | Code 状态码，参见通用信息 | 是 |
| success | boolean | 成功标识 | 是 |
| message | string | 消息 | 是 |
| data | object | 数据 | 是 |
| data.iccid | string | 运营商 ICCID | 是 |
| data.state | string | SIM 状态在运营商系统里的状态 | 是 |
| data.status | string | SIM 状态，参见通用部分定义 | 是 |
| data.activateTime | string | 激活时间 | 是 |
| data.lastChangeStateTime | string | 最后状态变更时间 | 是 |

响应示例：

```json
{
    "code": "00000",
    "success": true,
    "message": "操作成功",
    "data": {
        "iccid": "893107032536642026",
        "state": "Active",
        "status": "Activty",
        "activateTime": "2025-09-06T11:36:30",
        "lastChangeStateTime": "2025-10-27T07:46:48"
    }
}
```

Notes: 查询单张 SIM 卡的状态。

### 2.5 查询批量 SIM 卡状态（Query SIM Status）

- Method/Path: `POST /sim-card-sale/card/card-info/api/queryStatusBatch`
- Headers
  - token: string，必需
- Request Body

| 参数名称 | 数据类型 | 参数描述 | 是否必需 |
| :--- | :--- | :--- | :--- |
| iccids | array[string] | ICCID 列表 | 是 |

示例请求：

```json
{
"iccids": ["893107032536642026", "893107032536642338", "893107032536643267"]
}
```

- Response

| 参数名称 | 数据类型 | 参数描述 | 是否必需 |
| :--- | :--- | :--- | :--- |
| code | string | Code 状态码，参见通用信息 | 是 |
| success | boolean | 成功标识 | 是 |
| message | string | 消息 | 是 |
| data | array[object] | 数据 | 是 |
| data[].iccid | string | 运营商 ICCID | 是 |
| data[].state | string | SIM 状态在运营商系统里的状态 | 是 |
| data[].status | string | SIM 状态，参见通用部分定义 | 是 |
| data[].activateTime | string | 激活时间 | 是 |
| data[].lastChangeStateTime | string | 最后状态变更时间 | 是 |

响应示例：

```json
{
    "code": "00000",
    "success": true,
    "message": "操作成功",
    "data": [
        {
            "iccid": "893107032536642026",
            "state": "Active",
            "status": "Activty",
            "activateTime": "2025-09-06T11:36:30",
            "lastChangeStateTime": "2025-10-27T07:46:48"
        },
        {
            "iccid": "893107032536642338",
            "state": "Active",
            "status": "Activty",
            "activateTime": "2025-12-23T03:23:36",
            "lastChangeStateTime": "2026-03-05T02:11:46"
        },
        {
            "iccid": "893107032536643267",
            "state": "Active",
            "status": "Activty",
            "activateTime": "2026-05-08T05:30:15",
            "lastChangeStateTime": "2026-05-08T05:30:15"
        }
    ]
}
```

Notes: 查询一批 SIM 卡的状态。

### 2.6 查询单个 SIM 产品包ID、测试期数据使用量、本账期已使用数据流量（Query SIM Subscription）

- Method/Path: `POST /sim-card-sale/card/card-info/api/queryFlow`
- Headers
  - token: string，必需
- Request Body

| 参数名称 | 数据类型 | 参数描述 | 是否必需 |
| :--- | :--- | :--- | :--- |
| iccid | string | ICCID | 是 |

示例请求：

```json
{
  "iccid": "893107032536638542"
}
```

- Response

| 参数名称 | 数据类型 | 参数描述 | 是否必需 |
| :--- | :--- | :--- | :--- |
| code | string | Code 状态码，参见通用信息 | 是 |
| success | boolean | 成功标识 | 是 |
| message | string | 消息 | 是 |
| data | object | 数据 | 是 |
| data.iccid | string | 运营商 ICCID | 是 |
| data.usedFlow | integer | 本账期已使用数据流量，单位 KB | 是 |
| data.productCode | string | 产品包 ID，用于运营商类型 5 时识别产品包 | 是 |
| data.testFlow | integer | 测试期剩余流量（TestReady 状态），单位 KB | 是 |
| data.expirationDate | string | 测试期到期时间 | 是 |



响应示例：

```json
{
    "code": "00000",
    "success": true,
    "message": "操作成功",
    "data": {
        "iccid": "893107032536642026",
        "usedFlow": 6523978,
        "productCode": null,
        "testFlow": 0,
        "expirationDate": null
    }
}
```

Notes: 查询单张 SIM 卡订阅的产品包 ID 与测试期数据使用量。

### 2.7 查询批量 SIM 卡产品包ID与测试期数据使用量（Query Bulk SIMs Subscriptions）

- Method/Path: `POST /sim-card-sale/card/card-info/api/queryFlowsBatch`
- Headers
  - token: string，必需
- Request Body

| 参数名称 | 数据类型 | 参数描述 | 是否必需 |
| :--- | :--- | :--- | :--- |
| iccids | array[string] | ICCID 列表 | 是 |

示例请求：

```json
{
  "iccids": ["893107032536642026", "893107032536642338", "893107032536643267"]
}
```

- Response

| 参数名称 | 数据类型 | 参数描述 | 是否必需 |
| :--- | :--- | :--- | :--- |
| code | string | Code 状态码，参见通用信息 | 是 |
| success | boolean | 成功标识 | 是 |
| message | string | 消息 | 是 |
| data | array[object] | 数据 | 是 |
| data[].iccid | string | 运营商 ICCID | 是 |
| data[].usedFlow | integer | 本账期已使用数据流量，单位 KB | 是 |
| data[].productCode | string | 产品包 ID，用于运营商类型 5 时识别产品包 ID | 是 |
| data[].testFlow | integer | 测试期剩余流量（TestReady 状态），单位 KB | 是 |
| data[].expirationDate | string | 测试期到期时间 | 是 |



响应示例：

```json
{
    "code": "00000",
    "success": true,
    "message": "操作成功",
    "data": [
        {
            "iccid": "893107032536642026",
            "usedFlow": 6523978,
            "productCode": null,
            "testFlow": 0,
            "expirationDate": null
        },
        {
            "iccid": "893107032536642338",
            "usedFlow": 547,
            "productCode": null,
            "testFlow": 0,
            "expirationDate": null
        },
        {
            "iccid": "893107032536643267",
            "usedFlow": 4504435,
            "productCode": null,
            "testFlow": 0,
            "expirationDate": null
        }
    ]
}
```

Notes: 查询一批 SIM 卡订阅的产品包 ID 与测试期数据使用量。

### 2.8 查询指定月批量 SIM 卡数据使用量（Query SIM DataUsage in a Specified Month）

- Method/Path: `POST /sim-card/card/card-info/api/queryCdrFlowByMonth`
- Headers
  - token: string，必需
- Request Body

| 参数名称 | 数据类型 | 参数描述 | 是否必需 |
| :--- | :--- | :--- | :--- |
| month | string | 年月 | 是 |
| iccids | array[string] | ICCID 列表 | 是 |

示例请求：

```json
{
    "month":"2026-06",
    "iccids": ["893107032536642026", "893107032536642338", "893107032536643267"]
}
```

- Response

| 参数名称 | 数据类型 | 参数描述 | 是否必需 |
| :--- | :--- | :--- | :--- |
| code | string | Code 状态码，参见通用信息 | 是 |
| success | boolean | 成功标识 | 是 |
| message | string | 消息 | 是 |
| data | array[object] | 数据 | 是 |
| data[].month | string | 年月 | 是 |
| data[].iccid | string | 运营商 ICCID | 是 |
| data[].usedFlow | integer | 本账期已使用数据流量，单位 KB | 是 |

响应示例：

```json
{
    "code": "00000",
    "success": true,
    "message": "操作成功",
    "data": [
        {
            "month": "2026-06",
            "iccid": "893107032536642026",
            "usedFlow": 6523978
        },
        {
            "month": "2026-06",
            "iccid": "893107032536642338",
            "usedFlow": 547
        },
        {
            "month": "2026-06",
            "iccid": "893107032536643267",
            "usedFlow": 4504435
        }
    ]
}
```

Notes: 查询一批 SIM 卡在指定月的数据使用量。

### 2.9 查询指定日批量 SIM 卡数据使用量（Query SIM DataUsage in a Specified Day）

- Method/Path: `POST /sim-card/card/card-info/api/queryCdrFlowByDate`
- Headers
  - token: string，必需
- Request Body

| 参数名称 | 数据类型 | 参数描述 | 是否必需 |
| :--- | :--- | :--- | :--- |
| date | string | 日期 yyyy-MM-dd | 是 |
| iccids | array[string] | ICCID 列表 | 是 |

示例请求：

```json
{
     "date":"2026-06-13",
    "iccids": ["893107032536642026", "893107032536642338", "893107032536643267"]
}
```

- Response

| 参数名称 | 数据类型 | 参数描述 | 是否必需 |
| :--- | :--- | :--- | :--- |
| code | string | Code 状态码，参见通用信息 | 是 |
| success | boolean | 成功标识 | 是 |
| message | string | 消息 | 是 |
| data | array[object] | 数据 | 是 |
| data[].date | string | 日期 yyyy-MM-dd | 是 |
| data[].iccid | string | 运营商 ICCID | 是 |
| data[].usedFlow | integer | 本账期已使用数据流量，单位 KB | 是 |

响应示例：

```json
{
    "code": "00000",
    "success": true,
    "message": "操作成功",
    "data": [
        {
            "date": "2026-06-13",
            "iccid": "893107032536642026",
            "usedFlow": 1044042
        },
        {
            "date": "2026-06-13",
            "iccid": "893107032536643267",
            "usedFlow": 666831
        },
        {
            "date": "2026-06-13",
            "iccid": "893107032536642338",
            "usedFlow": 0
        }
    ]
}
```

Notes: 查询一批 SIM 卡在指定日的数据使用量。


### 2.10 查询系统里配置的产品包

- Method/Path: `POST /sim-card-sale/card/card-info/api/queryPackageInfo`
- Headers
  - token: string，必需
- Request Body
{}

示例请求：

```json
{}
```

- Response

| 参数名称 | 数据类型 | 参数描述 | 是否必需 |
| :--- | :--- | :--- | :--- |
| code | string | Code 状态码，参见通用信息 | 是 |
| success | boolean | 成功标识 | 是 |
| message | string | 消息 | 是 |
| data | array[object] | 数据 | 是 |
| data[].packageName | string | 产品包名称 | 是 |
| data[].packageCode | string | 产品包编码 | 是 |
| data[].cycleType | string | 产品包周期，0:DAILY_PACKAGE, 1:MONTHLY_PACKAGE, 2:YEARLY_PACKAGE | 是 |
| data[].cycleValue | integer | 计费周期 | 是 |
| data[].packageType | string | 产品包类型，0：MAIN产品包，1：Add_on产品包 | 是 |
| data[].totalFlow | integer | 产品包流量配额(单位MB) | 是 |
| data[].stopPrice | number<double> | 停机保号费 | 是 |
| data[].platformPrice | number<double> | 平台费 | 是 |
| data[].remark | string | 平台费 | 是 |


响应示例：

```json
{
    "code": "00000",
    "success": true,
    "message": "操作成功",
    "data": [
        {
            "packageName": "500M/月(测试SG)",
            "packageCode": "20250326133501",
            "cycleType": "1",
            "cycleValue": 1,
            "packageType": "0",
            "totalFlow": 500,
            "stopPrice": 1.00,
            "platformPrice": 1.00,
            "remark": "详情"
        },
        {
            "packageName": "苏州自测用卡",
            "packageCode": "20260602012827",
            "cycleType": "1",
            "cycleValue": 1,
            "packageType": "0",
            "totalFlow": 1,
            "stopPrice": 0.00,
            "platformPrice": 0.00,
            "remark": ""
        },
        {
            "packageName": "100M/月(越南)",
            "packageCode": "20240408033331",
            "cycleType": "1",
            "cycleValue": 1,
            "packageType": "0",
            "totalFlow": 100,
            "stopPrice": 0.00,
            "platformPrice": 0.00,
            "remark": ""
        },
        {
            "packageName": "50G/月（客情维系）",
            "packageCode": "20260302040617",
            "cycleType": "1",
            "cycleValue": 1,
            "packageType": "0",
            "totalFlow": 50,
            "stopPrice": 0.00,
            "platformPrice": 0.00,
            "remark": ""
        },
        {
            "packageName": "10G/月(测试TT)",
            "packageCode": "20250507095348",
            "cycleType": "1",
            "cycleValue": 1,
            "packageType": "0",
            "totalFlow": 10,
            "stopPrice": 0.00,
            "platformPrice": 0.00,
            "remark": "123"
        },
        {
            "packageName": "100M/月(印尼)",
            "packageCode": "20240408033311",
            "cycleType": "1",
            "cycleValue": 1,
            "packageType": "0",
            "totalFlow": 100,
            "stopPrice": 0.00,
            "platformPrice": 0.00,
            "remark": ""
        }
    ]
}
```

Notes: 查询一批 SIM 卡在指定日的数据使用量。


## 3. 业务操作接口
### 3.1 改变单个 SIM 卡的状态（Change SIM Status）

- Method/Path: `POST /sim-card-sale/card/card-info/api/updateCardStatus`
- Headers
  - token: string，必需
- Request Body

| 参数名称 | 数据类型 | 参数描述 | 是否必需 |
| :--- | :--- | :--- | :--- |
| iccid | string | 指定 SIM 卡的 ICCID 号 | 是 |
| operation | string | 停复机操作：Recover（复机/激活）、Stop（停机）、PreActive（预激活） | 是 |

示例请求：

```json
{
    "iccid": "893107032536638540",
    "operation": "Recover"
}
```

- Response

| 参数名称 | 数据类型 | 参数描述 | 是否必需 |
| :--- | :--- | :--- | :--- |
| code | string | Code 状态码，参见通用信息 | 是 |
| success | boolean | 成功标识 | 是 |
| message | string | 消息 | 是 |
| data | object | 数据 | 是 |
| data.iccid | string | 运营商 ICCID | 是 |
| data.success | boolean | 状态变更是否成功 | 是 |

响应示例：

```json
{
    "code": "00000",
    "success": true,
    "message": "操作成功",
    "data": {
        "iccid": "893107032536638540",
        "success": true
    }
}
```

Notes: 改变单张 SIM 卡的状态。

### 3.2 改变批量 SIM 卡的状态（Query Bulk SIMs Status）

- Method/Path: `POST /sim-card-sale/card/card-info/api/updateCardStatusBatch`
- Headers
  - token: string，必需
- Request Body

| 参数名称 | 数据类型 | 参数描述 | 是否必需 |
| :--- | :--- | :--- | :--- |
| iccids | array[string] | ICCID 列表 | 是 |
| operation | string | 停复机操作：Recover（复机/激活）、Stop（停机）、PreActive（预激活） | 是 |

示例请求：

```json
{
  "iccids": ["893107032536638540", "893107032536638542", "893107032536638543", "893107032536638550"],
  "operation": "Recover"
}
```

- Response

| 参数名称 | 数据类型 | 参数描述 | 是否必需 |
| :--- | :--- | :--- | :--- |
| code | string | Code 状态码，参见通用信息 | 是 |
| success | boolean | 成功标识 | 是 |
| message | string | 消息 | 是 |
| data | array[object] | 数据 | 是 |
| data[].iccid | string | 运营商 ICCID | 是 |
| data[].success | boolean | 状态变更是否成功 | 是 |

响应示例：

```json
{
    "code": "00000",
    "success": true,
    "message": "操作成功",
    "data": []
}
```

Notes: 改变一批 SIM 卡的状态。

### 3.3 为单个 SIM 卡订阅产品包（Subscription）

- Method/Path: `POST /sim-card/card/cardProductChange/api/modify`
- Headers
  - token: string，必需
- Request Body

| 参数名称 | 数据类型 | 参数描述 | 是否必需 |
| :--- | :--- | :--- | :--- |
| effectTime | string | 订阅生效时间（GMT+0）；为空表示立即生效 | 是 |
| iccid | string | 指定 SIM 卡的 ICCID 号 | 是 |
| productCode | string | 产品包 ID | 是 |

示例请求：

```json
{
    "effectTime": "2026-06-16 12:26:23",
    "iccid": "893107032536638540",
    "productCode": "3d6740ce-e2b0-4f70-860b-5828bef09e48"
}
```

- Response

| 参数名称 | 数据类型 | 参数描述 | 是否必需 |
| :--- | :--- | :--- | :--- |
| code | string | Code 状态码，参见通用信息 | 是 |
| success | boolean | 成功标识 | 是 |
| message | string | 消息 | 是 |
| data | object | 数据 | 是 |

响应示例：

```json
{
    "code": "00000",
    "success": true,
    "message": "操作成功",
    "data": null
}
```

Notes: 为指定 SIM 卡订阅一个产品包。

## 4. WEBHOOK 通知

### 4.1 SIM卡附着网络通知（LocationUpdate）

- Request Body

| 参数名称 | 数据类型 | 参数描述 | 是否必需 |
| :--- | :--- | :--- | :--- |
| messageType | string | 消息类型，在这里是 "LocationUpdate" | 是 |
| iccid | string | SIM 卡的 ICCID | 是 |
| msisdn | string | SIM 卡的 MSISDN | 是 |
| sign | string | 签名 | 是 |
| uuid | string | 流水 ID | 是 |
| data | object | 数据 | 是 |
| data.mncList | string | 拜访地运营商 MNC 可用列表 | 是 |
| data.eventTime | string | 发生时间 | 是 |
| data.mcc | string | 拜访地 MCC | 是 |

示例请求：

```json
{
  "messageType": "LocationUpdate",
  "iccid": "893107032536638539",
  "msisdn": "3197093496022",
  "sign": "6088248a77ffc52fe145108256440f1a7e5e6399a8847c8a76ce77de52fb5926",
  "uuid": "0956fd17-dcac-4b60-a782-09ad377d55bf",
  "data": {
    "mncList": "[01, 05, 06, 09]",
    "eventTime": "2025-05-06T14:23:16.7415127Z",
    "mcc": "460"
  }
}
```

Notes: SIM 卡附着网络的 Location Update 推送通知。

### 4.2 SIM卡流量预警通知（BalanceAlert）

- Request Body

| 参数名称 | 数据类型 | 参数描述 | 是否必需 |
| :--- | :--- | :--- | :--- |
| messageType | string | 消息类型，在这里是 "BalanceAlert" | 是 |
| iccid | string | SIM 卡的 ICCID | 是 |
| msisdn | string | SIM 卡的 MSISDN | 是 |
| data | object | 数据 | 是 |
| data.thresholdReached | string | 当前数据流量使用量已达到预设阈值的百分比 | 是 |
| data.eventTime | string | 发生时间 | 是 |
| data.limit | string | 运营商系统上该产品包的总配额，单位 MB | 是 |
| data.eventName | string | 事件类型，LowBalanceData-低流量，ExhaustBalanceData-用完流量 | 是 |
| data.balanceAmount | string | 剩余流量 | 是 |
| data.addOnID | string | 产品包 ID | 是 |
| sign | string | 签名 | 是 |
| uuid | string | 流水 ID | 是 |

示例请求：

```json
{
  "messageType": "BalanceAlert",
  "iccid": "893107032536638707",
  "msisdn": "3197092811813",
  "data": {
    "thresholdReached": "80",
    "eventTime": "2025-07-05T11:59:50.944Z",
    "limit": "20",
    "eventName": "LowBalanceData",
    "balanceAmount": "0",
    "addOnID": "d6e88f18-8b12-479c-baeb-1bae4578ee68"
  },
  "sign": "6088248a77ffc52fe145108256440f1a7e5e6399a8847c8a76ce77de52fb5926",
  "uuid": "0956fd17-dcac-4b60-a782-09ad377d55bf"
}
```

Notes: SIM 卡流量预警推送通知。

### 4.3 产品包订阅推送（ProductChange）

- Request Body

| 参数名称 | 数据类型 | 参数描述 | 是否必需 |
| :--- | :--- | :--- | :--- |
| messageType | string | 消息类型，在这里是 "ProductChange" | 是 |
| iccid | string | SIM 卡的 ICCID | 是 |
| msisdn | string | SIM 卡的 MSISDN | 是 |
| data | object | 数据 | 是 |
| data.addOnId | string | 产品包 ID | 是 |
| data.addOnType | string | 产品包类型 | 是 |
| data.startDate | string | 开始时间 | 是 |
| data.transactionId | string | 运营商流水 ID | 是 |
| data.expirationDate | string | 产品包到期时间，大部分产品包是没到期时间的 | 是 |
| sign | string | 签名 | 是 |
| uuid | string | 流水 ID | 是 |

示例请求：

```json
{
  "messageType": "ProductChange",
  "iccid": "893107032536638731",
  "msisdn": "3197093548320",
  "data": {
    "addOnId": "fe6e4d7e-7bb0-4553-b33f-69875b435b64",
    "addOnType": "ROAMING",
    "startDate": "2025-08-21T12:28:46.000Z",
    "transactionId": "2d480e8b-e8a5-4834-a9a4-d8e0aaef9547",
    "expirationDate": "2025-09-21T12:28:46.000Z"
  },
  "sign": "f161d51f-3f49-4d34-8854-3068f3a12996",
  "uuid": "f161d51f-3f49-4d34-8854-3068f3a12996"
}
```

Notes: SIM 卡订阅产品包的推送通知。

### 4.4 SIM卡状态变更通知（StatusChange）

- Request Body

| 参数名称 | 数据类型 | 参数描述 | 是否必需 |
| :--- | :--- | :--- | :--- |
| messageType | string | 消息类型，在这里是 "StatusChange" | 是 |
| iccid | string | SIM 卡的 ICCID | 是 |
| msisdn | string | SIM 卡的 MSISDN | 是 |
| sign | string | 签名 | 是 |
| uuid | string | 流水 ID | 是 |
| data | object | 数据 | 是 |
| data.toStatus | string | 新状态 | 是 |
| data.fromStatus | string | 原状态 | 是 |
| data.eventTime | string | 发生时间 | 是 |
| data.transactionId | string | 流水 ID | 是 |

示例请求：

```json
{
  "messageType": "StatusChange",
  "iccid": "893107032536638539",
  "msisdn": "3197093496022",
  "sign": "6088248a77ffc52fe145108256440f1a7e5e6399a8847c8a76ce77de52fb5926",
  "uuid": "0956fd17-dcac-4b60-a782-09ad377d55bf",
  "data": {
    "toStatus": "Active",
    "fromStatus": "PreActive",
    "eventTime": "2025-05-06T15:11:46.080Z",
    "transactionId": "9AAB4EF7-CBC3-4523-AD81-526F78D5D252"
  }
}
```

Notes: SIM 卡状态变更推送通知，状态以运营商系统为准。

