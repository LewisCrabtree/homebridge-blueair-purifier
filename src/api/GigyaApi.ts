import { Logger } from 'homebridge';
import { getGigyaConfig } from './Consts';
import { Region } from '../platformUtils';
import { BLUEAIR_API_TIMEOUT } from './Consts';
import { CloudHttpError, CloudCooldownError } from './RequestPolicy';

export default class GigyaApi {
  private api_key: string;
  private gigyaApiUrl: string;

  constructor(
    private readonly username: string,
    private readonly password: string,
    region: Region,
    private readonly logger: Logger,
  ) {
    const config = getGigyaConfig(region);

    this.logger.debug(`Gigya account region: ${region}`);

    this.api_key = config.apiKey;
    this.gigyaApiUrl = `https://accounts.${config.gigyaRegion}.gigya.com`;
  }

  public async getGigyaSession(): Promise<{ token: string; secret: string }> {
    const params = new URLSearchParams({
      apiKey: this.api_key,
      loginID: this.username,
      password: this.password,
      targetEnv: 'mobile',
    });

    const response = await this.apiCall('/accounts.login', params.toString());

    if (!response.sessionInfo) {
      throw new CloudCooldownError(15 * 60 * 1000, 'Blueair account authentication was rejected or locked; check credentials and region');
    }

    this.logger.debug('Gigya session received');
    return {
      token: response.sessionInfo.sessionToken,
      secret: response.sessionInfo.sessionSecret,
    };
  }

  public async getGigyaJWT(token: string, secret: string): Promise<{ jwt: string }> {
    const params = new URLSearchParams({
      oauth_token: token,
      secret: secret,
      targetEnv: 'mobile',
    });

    const response = await this.apiCall('/accounts.getJWT', params.toString());

    if (!response.id_token) {
      throw new Error('Gigya returned no JWT');
    }

    this.logger.debug('Gigya JWT received');
    return {
      jwt: response.id_token,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async apiCall(url: string, data: string): Promise<any> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BLUEAIR_API_TIMEOUT);
    try {
      const response = await fetch(`${this.gigyaApiUrl}${url}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: data,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new CloudHttpError(response.status);
      }
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}
