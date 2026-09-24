pnpm run verify:package

dsh plugin --profile sift remove '@songyanglin/dsh-sift'

dsh plugin --profile sift add 'D:\mycode\dsh-sift\.debug\verify\packages\songyanglin-dsh-sift-0.1.0.tgz'

dsh --profile sift --port 9011