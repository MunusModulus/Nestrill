# Nestrill v0.2.1 — ソースコード

Nestrill本体（JavaScript・HTML・CSS・PowerShell起動スクリプト）と、Windows用の起動ランチャー／セットアップEXEのソース一式です。Nestrill本体は[MIT License](LICENSE)です。通常の利用方法は [app/README.md](app/README.md) を参照してください。

## 構成

- `app/`: ポータブル配布版のソースとドキュメント。ランチャーバイナリとSHA-256マニフェストは配布ビルド時に生成します。
- `setup/launcher.go`: 起動用 `Nestrill.exe` のソース（Go標準ライブラリのみ）。
- `setup/setup.go`: WindowsセットアップEXEのソース。内部にビルドしたポータブルZIPとPowerShellスクリプトを埋め込みます。
- `setup/installer.ps1`: インストール／アンインストール処理。
- `BUILD_FROM_SOURCE.py`: ソースから配布ZIPとセットアップEXEを生成するビルドスクリプト。

## ビルド方法

Go 1.23以上、Python 3.9以上が必要です（Node.js 22.16以上はアプリ実行時に必要）。

```text
python BUILD_FROM_SOURCE.py
```

Windows用のEXEを生成するため、ビルドスクリプトは `GOOS=windows GOARCH=amd64 CGO_ENABLED=0` でGoを起動します。生成物は `dist/` に保存します。

ビルドに含まれるGo標準ライブラリのライセンスは `app/GO_LICENSE.txt`、Lucideなど第三者素材の表記は `app/THIRD_PARTY_NOTICES.md` を参照してください。

設定・履歴・認証情報・ログなどの利用データはソースZIPには収録していません。内部のコードコメントに過去の開発名が残る場合がありますが、ユーザー向けの起動名称はNestrillです。
